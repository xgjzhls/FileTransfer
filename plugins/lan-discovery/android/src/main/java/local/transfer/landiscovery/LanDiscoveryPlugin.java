package local.transfer.landiscovery;

import android.Manifest;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * ADR-0009 局域网发现插件 Android 实现（T03）：NsdManager 广告/浏览。
 *
 * 契约与共享 facade（T02 定义的 src/index.ts，iOS 同套）对齐：
 * - startAdvertising(DeviceInfo)/stopAdvertising/startBrowsing/stopBrowsing/getStatus，
 *   成功 resolve {ok:true}，失败 resolve {ok:false,error}（不 reject；权限被拒另带
 *   permissionDenied:true + error=PERMISSION_DENIED_MARKER）
 * - 事件：deviceFound（LanDevice = DeviceInfo & {serviceName,domain}）/
 *   deviceLost（{id}）/ permissionDenied
 * - TXT schema（txt.ts）：name/id/kind/port/ver，值 UTF-8 ≤255B，**键大小写不敏感**
 *   （RFC 6763；NsdManager 解析可能归一化大小写 —— 读侧统一 lower-case，
 *   跨平台互操作差异见 T03 备注，真机验证）
 * - **服务名 = deviceId**（与 iOS 实例名 = deviceId 一致：稳定唯一、免重名自动改名）；
 *   显示名在 TXT["name"]（iOS 侧同样语义，跨平台 LanDevice.serviceName 一致）
 * - 服务类型 `_localtranfer._tcp`（NsdManager 要求尾部点号；与 iOS 无点号写法等价）
 * - deviceFound 额外附 host（Android 解析结果；facade 类型未含，T04 连接用，
 *   JS 侧可读，多网卡设备可能为空串 —— 已知坑，真机待验）
 *
 * NsdManager 已知坑（本实现逐一处理）：
 * 1. resolveService 回调可能永不触发（mDNS announce 竞态）→ 串行解析 + 超时兜底；
 *    迟到回调以「当前解析名」代际门闩丢弃（completeResolve），绝不并发 resolve
 * 2. 并发 resolve 会丢回调 → 同一时刻只解析一个（worker 串行队列 + resolvingName 门闩）
 * 3. multicast lock 是 partial wakelock，泄漏会阻止休眠 → setReferenceCounted(false)
 *    显式持有/释放；停浏览/停广告/退后台/销毁/失败回调时统一回收（syncMulticastLock）
 * 4. unregisterService / stopServiceDiscovery 对未注册的 listener 抛
 *    IllegalArgumentException → try/catch 幂等；onDiscoveryStopped 可能不触发 →
 *    stopBrowsing 5s 超时兜底 resolve
 * 5. onServiceResolved 的 host 可能为 null（多网卡/双栈设备）→ 发出空串（坑 4 的 T04 后果）
 * 6. mDNS 周期重播（TTL 刷新）→ 已发出设备重发缓存事件（刷新 JS 侧 lastSeen，
 *    registry.ts TTL 兜底不误删活设备）；解析中消失 → lost 清门闩、迟到回调丢弃
 * 7. RX 过滤与 iOS 一致：name/id/ver 必填、port 1..65535、kind ∈ phone/tablet/desktop
 *    （同名服务类型的其他 App / 畸形 TXT 一律忽略）
 * 8. 注册/浏览失败回调即停：清状态（getStatus 不撒谎、重试不被幂等吞掉，iOS 同语义）
 *
 * 权限：Android 13+ 需 NEARBY_WIFI_DEVICES（neverForLocation）运行时授权 ——
 * 首次 start 时经 Capacitor 权限助手请求；拒绝 → ok:false + permissionDenied 事件 +
 * getStatus 反映（引导去设置重开，同 iOS 本地网络权限被拒语义）。
 *
 * 生命周期：退后台挂起广告/浏览（SPEC §5.5 前台为主；multicast lock 不常驻），
 * 回前台恢复原状态；destroy 全量清理。
 *
 * 线程：NsdManager 回调在 binder 线程 → 状态与 resolve 全部切到 main；
 * 解析队列在独立 HandlerThread（串行）。notifyListeners 线程安全。
 */
@CapacitorPlugin(
        name = "LanDiscovery",
        permissions = {
                @Permission(alias = "nearbyWifiDevices", strings = {Manifest.permission.NEARBY_WIFI_DEVICES})
        })
public class LanDiscoveryPlugin extends Plugin {

    private static final String TAG = "LanDiscovery";

    /** 与 facade（index.ts PERMISSION_DENIED_MARKER）一致的机器可识别标记 */
    private static final String PERMISSION_DENIED_MARKER = "LOCAL_NETWORK_DENIED";

    /** NsdManager 服务类型（尾部点号是 NsdManager 的规范形式，语义 = `_localtranfer._tcp`） */
    private static final String SERVICE_TYPE = "_localtranfer._tcp.";
    /** 无尾点基准形式（onServiceFound 的 serviceType 匹配时容差比较用） */
    private static final String BASE_SERVICE_TYPE = "_localtranfer._tcp";
    private static final int PROTOCOL = NsdManager.PROTOCOL_DNS_SD;

    /** resolve 超时兜底：NsdManager resolve 回调已知可能永不触发（坑 1） */
    private static final int RESOLVE_TIMEOUT_MS = 10_000;

    /** stopServiceDiscovery 的 onDiscoveryStopped 回调同样可能不触发 → 兜底 resolve */
    private static final int STOP_TIMEOUT_MS = 5_000;

    /** TXT kind 合法枚举（与 txt.ts LAN_KINDS / iOS 侧守卫一致） */
    private static final Set<String> KINDS = new HashSet<>(Arrays.asList("phone", "tablet", "desktop"));

    /** TXT 单值上限（RFC 6763）——原生侧兜底校验（txt.ts validateAdvertisingOptions 已校验） */
    private static final int TXT_VALUE_MAX_BYTES = 255;

    /** mDNS 默认域（与 registry.ts LanDevice.domain 语义一致） */
    private static final String DEFAULT_DOMAIN = "local.";

    private final Handler main = new Handler(Looper.getMainLooper());

    private NsdManager nsd;
    private WifiManager.MulticastLock multicastLock;

    // ---- 广告状态 ----
    private boolean advertising;
    private NsdServiceInfo advertisingInfo;   // 保存供后台恢复时重注册
    private NsdManager.RegistrationListener registrationListener;
    private PluginCall pendingRegisterCall;

    // ---- 浏览状态 ----
    private boolean browsing;
    private NsdManager.DiscoveryListener discoveryListener;
    private PluginCall pendingBrowseStartCall;
    private PluginCall pendingBrowseStopCall;

    // ---- 权限状态 ----
    private boolean permissionDenied;

    // ---- 解析串行队列（坑 2）：同一时刻只 resolve 一个 ----
    private final Map<String, NsdServiceInfo> resolveQueue = new LinkedHashMap<>();
    /** 已排队或正在解析的 serviceName（announce 重复触发时防止重复入队） */
    private final Set<String> resolvingNames = new HashSet<>();
    /** 当前正在解析的 serviceName；null = 空闲。仅 worker 线程访问（串行队列的状态门闩） */
    private String resolvingName;
    private HandlerThread workerThread;
    private Handler worker;

    /** serviceName → 已发出的 device（found/lost 配对 + 重复 announce 去重；name 可能因重名改名，id 才是稳定键） */
    private final Map<String, JSObject> emittedByName = new HashMap<>();

    // ------------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------------

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        requireNearbyPermission(call, () -> startAdvertisingInternal(call));
    }

    @PluginMethod
    public void stopAdvertising(PluginCall call) {
        main.post(() -> {
            stopAdvertisingInternal();
            resolveOk(call);
        });
    }

    @PluginMethod
    public void startBrowsing(PluginCall call) {
        requireNearbyPermission(call, () -> startBrowsingInternal(call));
    }

    @PluginMethod
    public void stopBrowsing(PluginCall call) {
        main.post(() -> {
            if (!browsing) {
                resolveOk(call); // 幂等
                return;
            }
            synchronized (this) {
                pendingBrowseStopCall = call; // onDiscoveryStopped（或内部异常路径）收尾 resolve
            }
            stopBrowsingInternal();
            // 兜底：onDiscoveryStopped 与 resolve 同类，已知可能不触发 → 超时后自行收尾
            main.postDelayed(() -> {
                PluginCall c = takePendingBrowseStopCall();
                resolveOk(c);
            }, STOP_TIMEOUT_MS);
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        main.post(() -> {
            JSObject o = new JSObject();
            o.put("advertising", advertising);
            o.put("browsing", browsing);
            o.put("permissionDenied", permissionDenied);
            call.resolve(o);
        });
    }

    // ------------------------------------------------------------------
    // 权限（Android 13+ NEARBY_WIFI_DEVICES）
    // ------------------------------------------------------------------

    private void requireNearbyPermission(PluginCall call, Runnable onGranted) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("nearbyWifiDevices") != PermissionState.GRANTED) {
            requestPermissionForAlias("nearbyWifiDevices", call, "nearbyPermissionCallback");
            return;
        }
        permissionDenied = false; // 已授权（含用户去设置重开后的再授权）：清陈旧拒绝态
        onGranted.run();
    }

    @PermissionCallback
    private void nearbyPermissionCallback(PluginCall call) {
        if (getPermissionState("nearbyWifiDevices") != PermissionState.GRANTED) {
            onNearbyPermissionDenied(call);
            return;
        }
        permissionDenied = false;
        if ("startAdvertising".equals(call.getMethodName())) {
            startAdvertisingInternal(call);
        } else {
            startBrowsingInternal(call);
        }
    }

    /** 权限被拒：状态记录 + permissionDenied 事件 + ok:false（facade StartResult 契约） */
    private void onNearbyPermissionDenied(PluginCall call) {
        permissionDenied = true;
        notifyListeners("permissionDenied", new JSObject());
        resolveStartFailure(call, PERMISSION_DENIED_MARKER, true);
    }

    // ------------------------------------------------------------------
    // 广告
    // ------------------------------------------------------------------

    /** 内部实现：幂等；call 可空（生命周期内部重启用，无人等待） */
    private void startAdvertisingInternal(PluginCall call) {
        main.post(() -> {
            if (advertising) {
                resolveOk(call); // 幂等
                return;
            }
            // call 为 null = 生命周期内部重启用：从上次广告信息重建（TXT 属性仍在 advertisingInfo 里）
            String name, id, kind, ver;
            Integer port;
            if (call == null) {
                if (advertisingInfo == null) {
                    return;
                }
                Map<String, String> txt = parseTxt(advertisingInfo.getAttributes());
                name = txt.get("name"); // 显示名在 TXT（服务名 = id，见类注释）
                id = txt.get("id");
                kind = txt.get("kind");
                ver = txt.get("ver");
                port = advertisingInfo.getPort();
            } else {
                name = call.getString("name");
                id = call.getString("id");
                kind = call.getString("kind");
                ver = call.getString("ver");
                port = call.getInt("port");
            }
            if (name == null || name.isEmpty() || id == null || id.isEmpty() || port == null
                    || !KINDS.contains(kind) || port < 1 || port > 65535) {
                resolveStartFailure(call, "startAdvertising 参数非法（name/id/kind/port 必填且合法）", false);
                return;
            }
            // 原生侧独立兜底校验（txt.ts 已校验，防御越桥直调）
            for (String v : new String[] { name, id, kind == null ? "" : kind, ver == null ? "" : ver }) {
                if (utf8Bytes(v) > TXT_VALUE_MAX_BYTES) {
                    resolveStartFailure(call, "TXT 值超过 255 字节（RFC 6763）", false);
                    return;
                }
            }

            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName(id); // 服务名 = deviceId（与 iOS 一致：稳定唯一，免重名自动改名）
            info.setServiceType(SERVICE_TYPE);
            info.setPort(port);                       // SRV 记录端口
            info.setAttribute("name", name);
            info.setAttribute("id", id);
            info.setAttribute("kind", kind == null ? "unknown" : kind);
            info.setAttribute("port", String.valueOf(port)); // TXT port（T04 取用；RFC 6763 值为 ASCII 数字串）
            info.setAttribute("ver", ver == null ? "" : ver);

            synchronized (this) {
                pendingRegisterCall = call; // onServiceRegistered / onRegistrationFailed 里收尾
            }
            registrationListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo registered) {
                    // 服务名 = deviceId，天然唯一 —— 正常无重名自动改名（iOS 同语义）
                    Log.d(TAG, "mDNS 已注册：serviceName=" + registered.getServiceName());
                    PluginCall c = takePendingRegisterCall();
                    resolveOk(c);
                }

                @Override
                public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    Log.w(TAG, "mDNS 注册失败 code=" + errorCode);
                    PluginCall c = takePendingRegisterCall();
                    main.post(() -> {
                        // 失败即停：清状态，getStatus 不撒谎、重试不被幂等吞掉（iOS .failed 同语义）
                        if (advertising) {
                            advertising = false;
                            advertisingInfo = null;
                            registrationListener = null;
                            syncMulticastLock();
                        }
                        resolveStartFailure(c, "mDNS 注册失败（code=" + errorCode + "）", false);
                    });
                }

                @Override
                public void onServiceUnregistered(NsdServiceInfo serviceInfo) {
                }

                @Override
                public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                }
            };

            advertisingInfo = info;
            advertising = true;
            syncMulticastLock();
            try {
                nsd().registerService(info, PROTOCOL, registrationListener);
            } catch (Exception e) {
                synchronized (this) {
                    pendingRegisterCall = null;
                }
                advertising = false;
                advertisingInfo = null;
                registrationListener = null;
                syncMulticastLock();
                resolveStartFailure(call, "registerService 失败：" + e.getMessage(), false);
            }
        });
    }

    /** 内部停止：幂等（unregister 是 fire-and-forget，无人等待其异步回调） */
    private void stopAdvertisingInternal() {
        if (!advertising) return;
        advertising = false;
        advertisingInfo = null;
        syncMulticastLock();
        if (registrationListener != null) {
            try {
                nsd().unregisterService(registrationListener);
            } catch (Exception e) {
                Log.w(TAG, "unregisterService: " + e);
            }
        }
        registrationListener = null;
        PluginCall c = takePendingRegisterCall(); // 尚未收到 onServiceRegistered 就停：直接成功
        resolveOk(c);
    }

    private synchronized PluginCall takePendingRegisterCall() {
        PluginCall c = pendingRegisterCall;
        pendingRegisterCall = null;
        return c;
    }

    // ------------------------------------------------------------------
    // 浏览
    // ------------------------------------------------------------------

    private void startBrowsingInternal(PluginCall call) {
        main.post(() -> {
            if (browsing) {
                resolveOk(call); // 幂等
                return;
            }
            browsing = true;
            syncMulticastLock();

            discoveryListener = new NsdManager.DiscoveryListener() {
                @Override
                public void onDiscoveryStarted(String serviceType) {
                    PluginCall c = takePendingBrowseStartCall();
                    resolveOk(c);
                }

                @Override
                public void onServiceFound(NsdServiceInfo serviceInfo) {
                    // 尾点号容差：个别设备/系统上报不带尾部点号的服务类型
                    if (matchesServiceType(serviceInfo.getServiceType())) {
                        enqueueResolve(serviceInfo);
                    }
                }

                @Override
                public void onServiceLost(NsdServiceInfo serviceInfo) {
                    handleLost(serviceInfo);
                }

                @Override
                public void onDiscoveryStopped(String serviceType) {
                    PluginCall c = takePendingBrowseStopCall();
                    resolveOk(c);
                }

                @Override
                public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "onStartDiscoveryFailed code=" + errorCode);
                    PluginCall c = takePendingBrowseStartCall();
                    main.post(() -> {
                        // 失败即停：清状态，getStatus 不撒谎、重试不被幂等吞掉（iOS 同语义）
                        if (browsing) {
                            browsing = false;
                            discoveryListener = null;
                            syncMulticastLock();
                        }
                        resolveStartFailure(c, "mDNS 浏览启动失败（code=" + errorCode + "）", false);
                    });
                }

                @Override
                public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                    Log.w(TAG, "onStopDiscoveryFailed code=" + errorCode);
                    PluginCall c = takePendingBrowseStopCall();
                    resolveOk(c); // 停止失败也视为已停（幂等语义）
                }
            };

            synchronized (this) {
                pendingBrowseStartCall = call;
            }
            try {
                nsd().discoverServices(SERVICE_TYPE, PROTOCOL, discoveryListener);
            } catch (Exception e) {
                browsing = false;
                discoveryListener = null;
                syncMulticastLock();
                synchronized (this) {
                    pendingBrowseStartCall = null;
                }
                resolveStartFailure(call, "discoverServices 失败：" + e.getMessage(), false);
            }
        });
    }

    private void stopBrowsingInternal() {
        if (!browsing) return;
        browsing = false;
        syncMulticastLock();
        if (discoveryListener != null) {
            try {
                nsd().stopServiceDiscovery(discoveryListener);
            } catch (Exception e) {
                Log.w(TAG, "stopServiceDiscovery: " + e);
                // listener 未注册（异常中断过）：直接成功
                PluginCall c = takePendingBrowseStopCall();
                resolveOk(c);
            }
        }
    }

    private synchronized PluginCall takePendingBrowseStartCall() {
        PluginCall c = pendingBrowseStartCall;
        pendingBrowseStartCall = null;
        return c;
    }

    private synchronized PluginCall takePendingBrowseStopCall() {
        PluginCall c = pendingBrowseStopCall;
        pendingBrowseStopCall = null;
        return c;
    }

    /**
     * 解析串行入队（坑 2）：同一时刻只 resolve 一个。
     * - 已发出的设备（emittedByName）收到刷新 announce：不重新解析，重发缓存设备
     *   （mDNS 周期重播，刷新 JS 侧 lastSeen —— registry.ts TTL 兜底不误删活设备；
     *   语义对齐 facade deviceFound「发现或变化」）
     * - 已排队 / 解析中：去重忽略
     */
    private void enqueueResolve(NsdServiceInfo serviceInfo) {
        worker().post(() -> {
            String name = serviceInfo.getServiceName();
            JSObject cached = emittedByName.get(name);
            if (cached != null) {
                notifyListeners("deviceFound", cached); // 刷新 announce：重发（lastSeen 刷新）
                return;
            }
            if (resolveQueue.containsKey(name) || resolvingNames.contains(name)) {
                return;
            }
            resolveQueue.put(name, serviceInfo);
            drainResolveQueue();
        });
    }

    /**
     * 串行解析核心：同一时刻只发起一个 resolve（NsdManager 并发 resolve 会丢回调）。
     * 所有状态（resolvingName/resolvingNames）仅 worker 线程访问；
     * 回调/超时/异常统一走 completeResolve —— 以「当前解析名」作代际门闩，
     * 迟到的旧回调（超时后 / lost 后 / 已被替代后）一律丢弃，绝不破坏串行性。
     */
    private void drainResolveQueue() {
        if (resolvingName != null || resolveQueue.isEmpty()) return;
        Map.Entry<String, NsdServiceInfo> next = resolveQueue.entrySet().iterator().next();
        resolveQueue.remove(next.getKey());

        final String name = next.getKey();
        final NsdServiceInfo info = next.getValue();
        resolvingName = name;
        resolvingNames.add(name);
        final Runnable timeout = () -> {
            if (!name.equals(resolvingName)) return; // 已由回调 / lost 收尾
            // 坑 1：resolve 回调可能永不触发 → 超时放弃，继续下一个（若被重新发现会再入队）
            Log.w(TAG, "resolve 超时：" + name);
            resolvingName = null;
            resolvingNames.remove(name);
            drainResolveQueue();
        };
        worker().postDelayed(timeout, RESOLVE_TIMEOUT_MS);

        try {
            nsd().resolveService(info, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    Log.d(TAG, "resolve 失败 " + serviceInfo.getServiceName() + " code=" + errorCode);
                    completeResolve(name, timeout, null);
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolved) {
                    completeResolve(name, timeout, resolved);
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "resolveService 异常：" + e);
            completeResolve(name, timeout, null);
        }
    }

    /** 解析收尾（worker 线程）：代际门闩 —— 仅当仍是当前解析时才清状态、发事件、继续队列 */
    private void completeResolve(String name, Runnable timeout, NsdServiceInfo resolved) {
        worker.post(() -> {
            worker.removeCallbacks(timeout);
            if (!name.equals(resolvingName)) return; // 过期回调（已超时 / 已 lost / 已被替代）→ 丢弃
            resolvingName = null;
            resolvingNames.remove(name);
            if (resolved != null) {
                emitDiscovered(resolved);
            }
            drainResolveQueue();
        });
    }

    private void emitDiscovered(NsdServiceInfo resolved) {
        JSObject device = deviceFrom(resolved);
        if (device == null) return; // TXT 过滤（坑 7）：畸形/非本应用服务 → 忽略，队列继续
        worker().post(() -> {
            emittedByName.put(resolved.getServiceName(), device);
            notifyListeners("deviceFound", device);
        });
    }

    private void handleLost(NsdServiceInfo serviceInfo) {
        worker().post(() -> {
            String name = serviceInfo.getServiceName();
            resolveQueue.remove(name);
            resolvingNames.remove(name);
            if (name.equals(resolvingName)) {
                // 解析中消失：清门闩 —— 迟到的 resolve 回调会被 completeResolve 的代际门闩丢弃
                resolvingName = null;
            }
            JSObject device = emittedByName.remove(name);
            if (device != null) {
                // facade deviceLost 载荷 = { id }
                JSObject o = new JSObject();
                o.put("id", device.getString("id"));
                notifyListeners("deviceLost", o);
            }
        });
    }

    /**
     * TXT → deviceFound 载荷（LanDevice = DeviceInfo & {serviceName,domain} + Android 附加 host）。
     * RX 过滤与 iOS 侧守卫一致：name/id/ver 必填、port 1..65535、kind ∈ phone/tablet/desktop
     * —— 同名服务类型的其他 App / 畸形 TXT 一律忽略（跨平台列表一致性）。
     */
    private JSObject deviceFrom(NsdServiceInfo resolved) {
        Map<String, String> txt = parseTxt(resolved.getAttributes());
        String name = txt.get("name");
        String id = txt.get("id");
        String kind = txt.get("kind");
        String ver = txt.get("ver");
        int port = parseIntOrZero(txt.get("port"));
        if (name == null || id == null || ver == null
                || !KINDS.contains(kind) || port < 1 || port > 65535) {
            return null;
        }

        JSObject o = new JSObject();
        o.put("name", name);
        o.put("id", id);
        o.put("kind", kind);
        o.put("port", port);
        o.put("ver", ver);
        o.put("serviceName", resolved.getServiceName());
        o.put("domain", DEFAULT_DOMAIN);
        InetAddress host = resolved.getHost();
        // 坑 5：多网卡设备 host 可能为 null —— 发出空串（T04 连接受阻属真机待验项）
        o.put("host", host != null ? host.getHostAddress() : "");
        return o;
    }

    /** 服务类型匹配：尾点号容差（_localtranfer._tcp. 与 _localtranfer._tcp 等价） */
    private static boolean matchesServiceType(String type) {
        if (type == null) return false;
        return stripTrailingDot(type).equals(BASE_SERVICE_TYPE);
    }

    private static String stripTrailingDot(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '.') {
            end--;
        }
        return s.substring(0, end);
    }

    /** RFC 6763 TXT 解析：键大小写不敏感（读侧统一 lower-case；NsdManager 解析可能归一化大小写） */
    private static Map<String, String> parseTxt(Map<String, byte[]> attrs) {
        Map<String, String> out = new HashMap<>();
        if (attrs == null) return out;
        for (Map.Entry<String, byte[]> e : attrs.entrySet()) {
            String key = e.getKey().toLowerCase(Locale.ROOT);
            out.put(key, new String(e.getValue(), StandardCharsets.UTF_8));
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Multicast lock（坑 3：partial wakelock，泄漏阻止休眠）
    // ------------------------------------------------------------------

    /** 广告或浏览任一激活即持有锁；全停即释放 */
    private void syncMulticastLock() {
        if (advertising || browsing) {
            acquireMulticastLock();
        } else {
            releaseMulticastLock();
        }
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) appContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            if (multicastLock == null) {
                multicastLock = wifi.createMulticastLock("localtranfer-nsd");
                multicastLock.setReferenceCounted(false);
            }
            if (!multicastLock.isHeld()) {
                multicastLock.acquire();
            }
        } catch (SecurityException e) {
            // 缺 CHANGE_WIFI_MULTICAST_STATE（manifest 已声明，防御异常环境）
            Log.w(TAG, "multicast lock 获取失败：" + e);
        }
    }

    private void releaseMulticastLock() {
        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
        }
    }

    // ------------------------------------------------------------------
    // 生命周期（SPEC §5.5：前台为主 —— 后台挂起，回前台恢复）
    // ------------------------------------------------------------------

    @Override
    protected void handleOnPause() {
        main.post(() -> {
            boolean wantAdvertising = advertising;
            NsdServiceInfo savedInfo = advertisingInfo; // stopAdvertisingInternal 会清掉，先存
            boolean wantBrowsing = browsing;
            stopAdvertisingInternal(); // 停 + 释放锁（pendingRegisterCall 顺带收尾）
            stopBrowsingInternal();
            advertising = wantAdvertising; // 恢复标志（内部已停、锁已释放）
            advertisingInfo = savedInfo;
            browsing = wantBrowsing;
        });
    }

    @Override
    protected void handleOnResume() {
        main.post(() -> {
            if (advertising && advertisingInfo != null) {
                startAdvertisingInternal(null);
            }
            if (browsing) {
                startBrowsingInternal(null);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            stopAdvertisingInternal();
            stopBrowsingInternal();
            releaseMulticastLock();
            if (workerThread != null) {
                workerThread.quitSafely();
                workerThread = null;
                worker = null;
            }
        });
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    /** 成功：resolve {ok:true}（facade StartResult/StopResult 契约） */
    private static void resolveOk(PluginCall call) {
        if (call == null) return;
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
    }

    /** 失败：resolve {ok:false, error}（权限被拒另带 permissionDenied:true）——不 reject */
    private static void resolveStartFailure(PluginCall call, String error, boolean denied) {
        if (call == null) return;
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", error);
        if (denied) {
            o.put("permissionDenied", true);
        }
        call.resolve(o);
    }

    private NsdManager nsd() {
        if (nsd == null) {
            nsd = (NsdManager) appContext().getSystemService(Context.NSD_SERVICE);
        }
        return nsd;
    }

    private Context appContext() {
        return getContext().getApplicationContext();
    }

    private Handler worker() {
        if (worker == null) {
            workerThread = new HandlerThread("lan-discovery-resolve");
            workerThread.start();
            worker = new Handler(workerThread.getLooper());
        }
        return worker;
    }

    private static int utf8Bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }

    private static int parseIntOrZero(String s) {
        if (s == null) return 0;
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
