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

import org.json.JSONException;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

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

    // ---- 原生信令通道（T04）：TCP 监听/连接 + 竞态消解（全部状态 main/sync 保护） ----
    private ServerSocket signalingServer;
    private int signalingServerPort;
    private boolean signalingEnabled;
    private String selfDeviceId;
    /** peerId → 活跃通道（每对端恰好一条；竞态收敛后） */
    private final Map<String, ChannelContext> channels = new HashMap<>();
    /** peerId → 连接建立中的出向连接 */
    private final Map<String, ChannelContext> outboundPending = new HashMap<>();

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
            o.put("signaling", signalingServer != null); // T04：信令服务器在监听
            call.resolve(o);
        });
    }

    // ------------------------------------------------------------------
    // 原生信令通道（T04，ADR-0009 决策 1）—— 信令「单协议多载体」的第三种载体
    // ------------------------------------------------------------------
    //
    // Wire 协议（与 channel.ts / iOS 逐条对齐，T04 设计定稿）：
    // - 帧 = 4B 大端长度前缀 + UTF-8 JSON（DataOutputStream/InputStream 原生大端）；上限 64 KiB
    // - hello：发起方连上即发 {v:1,type:hello,id,session}，接收方不回
    // - signal：{v:1,type:signal,kind:offer|answer,sdp}（sdp = gzip+base64url，透明）
    // - TCP 断开 = 断线
    //
    // 竞态（两台同时发起）：低 deviceId 胜 —— 幸存连接 = 低 id 方发起的连接。
    // 激活点有两处（出向连接成功发完 hello / 入向收到 hello），两侧独立套同一规则收敛。
    //
    // 线程：插件方法 main 线程；accept/read/connect 在独立 daemon 线程；状态经 this 同步。
    // 事件：peerConnected {id,session,role} / peerDisconnected {id} /
    //       messageReceived {from,session,kind,sdp} / signalingError {peerId?,code,message}

    /** 单帧上限（与 channel.ts MAX_FRAME_BYTES / iOS maxFrameBytes 一致） */
    private static final int MAX_FRAME_BYTES = 64 * 1024;

    /** connect 超时（Socket 内建；iOS 侧同 10s 兜底） */
    private static final int CONNECT_TIMEOUT_MS = 10_000;

    /** 一条 TCP 连接的读写上下文（含竞态消解后的通道归属）；peerId/session/role 入向待 hello 填充 */
    private static class ChannelContext {
        final Socket socket;
        final boolean isOutbound;
        String peerId;
        String session;
        String role;
        volatile boolean terminated;

        ChannelContext(Socket socket, boolean isOutbound, String peerId) {
            this.socket = socket;
            this.isOutbound = isOutbound;
            this.peerId = peerId;
        }
    }

    @PluginMethod
    public void startSignalingServer(PluginCall call) {
        requireNearbyPermission(call, () -> startSignalingServerInternal(call));
    }

    /** 启动信令服务器：绑定 device.port + NsdManager 注册（SRV 端口 = TXT port = 监听端口）。
     *  与旧 startAdvertising（纯广告）双模式互斥：本方法一体（广告+监听），旧广告让位。 */
    private void startSignalingServerInternal(PluginCall call) {
        main.post(() -> {
            if (signalingServer != null) {
                resolveServerOk(call); // 幂等
                return;
            }
            JSObject device = call.getObject("device");
            if (device == null) {
                call.reject("startSignalingServer 缺 device 参数");
                return;
            }
            String name = device.getString("name");
            String id = device.getString("id");
            String kind = device.getString("kind");
            String ver = device.getString("ver");
            Integer port = device.getInteger("port");
            if (name == null || id == null || port == null || !KINDS.contains(kind)
                    || port < 1 || port > 65535) {
                call.reject("startSignalingServer 参数非法（device.name/id/kind/port/ver）");
                return;
            }
            try {
                signalingServer = new ServerSocket(port);
            } catch (IOException e) {
                // 端口被占 / 绑定失败 → 明确回调（JS 依次试后续端口）
                call.resolve(startFail("PORT_IN_USE"));
                return;
            }
            signalingServerPort = port;
            signalingEnabled = true;
            selfDeviceId = id;
            startAcceptLoop();
            // mDNS 注册（SRV = port = TXT port）：旧纯广告模式让位，避免同名双注册冲突
            stopAdvertisingInternal();
            registerSignalingService(name, id, kind, port, ver == null ? "" : ver);
            resolveServerOk(call);
        });
    }

    private void resolveServerOk(PluginCall call) {
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("port", signalingServerPort);
        call.resolve(o);
    }

    /** 注册信令服务（复用 advertising 状态字段：getStatus.advertising 在双模式下都反映「可被发现」） */
    private void registerSignalingService(String name, String id, String kind, int port, String ver) {
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(id);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        info.setAttribute("name", name);
        info.setAttribute("id", id);
        info.setAttribute("kind", kind);
        info.setAttribute("port", String.valueOf(port));
        info.setAttribute("ver", ver);
        registrationListener = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo registered) {
                Log.d(TAG, "信令服务已注册：serviceName=" + registered.getServiceName()
                        + " port=" + registered.getPort());
                PluginCall c = takePendingRegisterCall();
                resolveOk(c);
            }

            @Override
            public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                Log.w(TAG, "信令服务注册失败 code=" + errorCode);
                PluginCall c = takePendingRegisterCall();
                main.post(() -> {
                    if (advertising) { // 失败即停（与 T03 语义一致）；信令 TCP 监听不受影响
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
            advertising = false;
            advertisingInfo = null;
            registrationListener = null;
            syncMulticastLock();
            Log.w(TAG, "registerService 失败：" + e);
        }
    }

    @PluginMethod
    public void stopSignalingServer(PluginCall call) {
        main.post(() -> {
            List<String> peerIds;
            synchronized (this) {
                peerIds = new ArrayList<>(channels.keySet());
            }
            for (String peerId : peerIds) {
                ChannelContext ctx;
                synchronized (this) {
                    ctx = channels.get(peerId);
                }
                if (ctx != null) closeChannel(ctx, true); // 主动停 → 通知 JS（含对端，经 TCP 关闭传播）
            }
            synchronized (this) {
                outboundPending.clear();
            }
            stopAdvertisingInternal(); // 取消 mDNS 注册（双模式互斥）
            if (signalingServer != null) {
                try {
                    signalingServer.close(); // accept 循环抛 SocketException 退出
                } catch (IOException ignored) {
                }
                signalingServer = null;
            }
            signalingServerPort = 0;
            signalingEnabled = false;
            call.resolve(okObj());
        });
    }

    /** accept 循环（daemon）：每连接一个 reader 线程，首帧必须是 hello */
    private void startAcceptLoop() {
        Thread t = new Thread(() -> {
            while (signalingServer != null) {
                try {
                    Socket socket = signalingServer.accept();
                    Thread reader = new Thread(() -> handleInbound(socket), "lan-signal-inbound");
                    reader.setDaemon(true);
                    reader.start();
                } catch (IOException e) {
                    break; // 服务器关闭（stopSignalingServer）
                }
            }
        }, "lan-signal-accept");
        t.setDaemon(true);
        t.start();
    }

    private void handleInbound(Socket socket) {
        ChannelContext ctx = new ChannelContext(socket, false, null);
        readLoop(ctx);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        main.post(() -> {
            JSObject peer = call.getObject("peer");
            String myId = call.getString("myId");
            if (peer == null || myId == null || myId.isEmpty()) {
                call.reject("connect 参数非法（peer/myId 必填）");
                return;
            }
            String peerId = peer.getString("id");
            Integer port = peer.getInteger("port");
            String host = peer.getString("host");
            if (peerId == null || port == null || port < 1 || port > 65535) {
                call.reject("connect 参数非法（peer.id/port）");
                return;
            }
            synchronized (this) {
                if (channels.containsKey(peerId)) {
                    call.resolve(okObj()); // 已连接（幂等：竞态消解可能已把入向通道激活）
                    return;
                }
                if (outboundPending.containsKey(peerId)) {
                    call.resolve(startFail("ALREADY_CONNECTING"));
                    return;
                }
            }
            if (host == null || host.isEmpty()) {
                // 坑 5（多网卡 resolve host 为空）→ 明确回调（JS 提示重新发现/重试）
                call.resolve(startFail("HOST_UNKNOWN"));
                return;
            }
            selfDeviceId = myId;
            final String peerIdF = peerId;
            Thread t = new Thread(() -> doConnect(call, peerIdF, host, port, myId), "lan-signal-connect");
            t.setDaemon(true);
            t.start();
        });
    }

    /** 出向连接（worker 线程）：connect 超时 10s → hello → 出向激活点 → 读循环 */
    private void doConnect(PluginCall call, String peerId, String host, int port, String myId) {
        ChannelContext ctx = null;
        try {
            Socket socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            ctx = new ChannelContext(socket, true, peerId);
            ctx.session = UUID.randomUUID().toString();
            ctx.role = "initiator";
            synchronized (this) {
                outboundPending.put(peerId, ctx);
            }
            writeFrame(socket.getOutputStream(), helloJson(myId, ctx.session));
            activate(ctx); // 出向激活点（竞态判定在 activate 内）
            call.resolve(okObj());
            readLoop(ctx); // 激活后继续读帧（signal / 断线收尾）
        } catch (SocketTimeoutException e) {
            failConnect(call, ctx, peerId, "CONNECTION_TIMEOUT");
        } catch (IOException e) {
            failConnect(call, ctx, peerId, "CONNECTION_REFUSED");
        }
    }

    private void failConnect(PluginCall call, ChannelContext ctx, String peerId, String code) {
        if (ctx != null) {
            ctx.terminated = true;
            closeQuietly(ctx.socket);
        }
        synchronized (this) {
            outboundPending.remove(peerId);
        }
        emitSignalingError(peerId, code, "连接失败：" + code);
        call.resolve(startFail(code));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        main.post(() -> {
            String peerId = call.getString("peerId");
            if (peerId == null) {
                call.reject("disconnect 缺 peerId");
                return;
            }
            ChannelContext ctx;
            synchronized (this) {
                ctx = channels.get(peerId);
            }
            if (ctx != null) closeChannel(ctx, true);
            synchronized (this) {
                ChannelContext pending = outboundPending.remove(peerId);
                if (pending != null) closeQuietly(pending.socket);
            }
            call.resolve(okObj());
        });
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        main.post(() -> {
            String peerId = call.getString("peerId");
            String kind = call.getString("kind");
            String sdp = call.getString("sdp");
            if (peerId == null || sdp == null || sdp.isEmpty()
                    || (!"offer".equals(kind) && !"answer".equals(kind))) {
                call.reject("sendMessage 参数非法（peerId/kind(offer|answer)/sdp）");
                return;
            }
            ChannelContext ctx;
            synchronized (this) {
                ctx = channels.get(peerId);
            }
            if (ctx == null) {
                call.resolve(startFail("NOT_CONNECTED"));
                return;
            }
            try {
                writeFrame(ctx.socket.getOutputStream(), signalJson(kind, sdp));
                call.resolve(okObj());
            } catch (IOException e) {
                emitSignalingError(peerId, "NOT_CONNECTED", "发送失败：" + e.getMessage());
                call.resolve(startFail("NOT_CONNECTED"));
            }
        });
    }

    // ------------------------------------------------------------------
    // 读循环 / 帧分发 / 竞态（与 iOS 同协议同规则）
    // ------------------------------------------------------------------

    /** 读循环（连接线程）：4B 大端长度 → 恰好 length 字节 → 重复；EOF/异常 → 断线收尾 */
    private void readLoop(ChannelContext ctx) {
        try (DataInputStream dis = new DataInputStream(ctx.socket.getInputStream())) {
            while (!ctx.terminated) {
                int len;
                try {
                    len = dis.readInt(); // 大端（DataInputStream 默认）
                } catch (IOException e) {
                    break; // EOF（对端断开）/ 连接异常
                }
                if (len > MAX_FRAME_BYTES) {
                    protocolViolation(ctx); // 帧长度超上限
                    break;
                }
                byte[] payload = new byte[len];
                dis.readFully(payload);
                JSONObject msg;
                try {
                    msg = new JSONObject(new String(payload, StandardCharsets.UTF_8));
                } catch (JSONException e) {
                    protocolViolation(ctx);
                    break;
                }
                if (!handleFrame(ctx, msg)) break; // 协议违规已收尾
            }
        } catch (IOException e) {
            // 读取异常 → 断线收尾
        } finally {
            connectionEnded(ctx);
        }
    }

    /** 帧分发：入向首帧必须是 hello；之后只收 signal（其余 → 协议违规）。返回 false = 已收尾 */
    private boolean handleFrame(ChannelContext ctx, JSONObject msg) {
        if (msg.optInt("v", 0) != 1) {
            protocolViolation(ctx);
            return false;
        }
        switch (msg.optString("type", "")) {
            case "hello": {
                if (ctx.isOutbound || ctx.peerId != null) {
                    protocolViolation(ctx); // 接收方不回 hello；出向不应收到 hello
                    return false;
                }
                String id = msg.optString("id", "");
                String session = msg.optString("session", "");
                if (id.isEmpty() || session.isEmpty()) {
                    protocolViolation(ctx);
                    return false;
                }
                ctx.peerId = id;
                ctx.session = session;
                ctx.role = "receiver";
                activate(ctx); // 入向激活点（竞态判定在 activate 内）
                return true;
            }
            case "signal": {
                String kind = msg.optString("kind", "");
                String sdp = msg.optString("sdp", "");
                if ((!"offer".equals(kind) && !"answer".equals(kind)) || sdp.isEmpty()) {
                    protocolViolation(ctx);
                    return false;
                }
                if (ctx.peerId == null || ctx.session == null) {
                    protocolViolation(ctx); // 未握手即发 signal
                    return false;
                }
                JSObject evt = new JSObject();
                evt.put("from", ctx.peerId);
                evt.put("session", ctx.session);
                evt.put("kind", kind);
                evt.put("sdp", sdp);
                notifyListeners("messageReceived", evt);
                return true;
            }
            default:
                protocolViolation(ctx);
                return false;
        }
    }

    /**
     * 激活点（出向 connect 成功发完 hello / 入向收到 hello 两处调用）：
     * 若该对端已有活跃通道 → 竞态消解（低 deviceId 胜：保留下方发起的连接）。
     * 被弃连接：已激活的记 peerDisconnected；未激活的静默关闭（从未对外）。
     */
    private void activate(ChannelContext ctx) {
        synchronized (this) {
            if (ctx.terminated || ctx.peerId == null) return;
            ChannelContext existing = channels.get(ctx.peerId);
            if (existing != null && !existing.terminated) {
                boolean keepOutbound = selfDeviceId != null && selfDeviceId.compareTo(ctx.peerId) < 0;
                if (ctx.isOutbound == keepOutbound) {
                    closeChannelLocked(existing, true); // 候选胜：弃现有（若已对外 → 通知）
                    activateAsLocked(ctx);
                } else {
                    ctx.terminated = true; // 候选弃：静默关闭（从未激活对外）
                    closeQuietly(ctx.socket);
                }
                return;
            }
            activateAsLocked(ctx);
        }
    }

    private void activateAsLocked(ChannelContext ctx) {
        channels.put(ctx.peerId, ctx);
        JSObject evt = new JSObject();
        evt.put("id", ctx.peerId);
        evt.put("session", ctx.session);
        evt.put("role", ctx.role);
        notifyListeners("peerConnected", evt);
    }

    /** 关闭通道：通知（peerDisconnected）+ 关闭 socket（幂等） */
    private void closeChannel(ChannelContext ctx, boolean notify) {
        synchronized (this) {
            closeChannelLocked(ctx, notify);
        }
    }

    private void closeChannelLocked(ChannelContext ctx, boolean notify) {
        if (ctx.terminated) return;
        ctx.terminated = true;
        if (notify && ctx.peerId != null) {
            if (channels.get(ctx.peerId) == ctx) {
                channels.remove(ctx.peerId);
                notifyListeners("peerDisconnected", idObj(ctx.peerId));
            }
        }
        closeQuietly(ctx.socket);
    }

    /** 连接失败 / 对端关闭 / EOF → 收尾（peerDisconnected + 清理 pending） */
    private void connectionEnded(ChannelContext ctx) {
        String peerId;
        boolean notify = false;
        synchronized (this) {
            if (ctx.terminated) return;
            ctx.terminated = true;
            peerId = ctx.peerId;
            if (peerId != null && channels.get(peerId) == ctx) {
                channels.remove(peerId);
                notify = true;
            }
            if (peerId != null && outboundPending.get(peerId) == ctx) {
                outboundPending.remove(peerId);
            }
        }
        if (notify && peerId != null) {
            notifyListeners("peerDisconnected", idObj(peerId));
        }
        closeQuietly(ctx.socket);
    }

    /** 协议违规（坏帧/缺 hello/未知 type/超限）→ 关闭连接 + signalingError */
    private void protocolViolation(ChannelContext ctx) {
        String peerId = ctx.peerId;
        if (peerId != null) {
            emitSignalingError(peerId, "PROTOCOL_VIOLATION", "帧/消息非法，关闭连接");
        } else {
            emitSignalingError(null, "PROTOCOL_VIOLATION", "握手前非法帧，关闭连接");
        }
        connectionEnded(ctx);
    }

    // ------------------------------------------------------------------
    // 帧编解码 / 事件（与 channel.ts / iOS 同格式）
    // ------------------------------------------------------------------

    private static void writeFrame(OutputStream os, JSONObject msg) throws IOException {
        byte[] payload = msg.toString().getBytes(StandardCharsets.UTF_8);
        if (payload.length > MAX_FRAME_BYTES) {
            throw new IOException("frame too large");
        }
        DataOutputStream dos = new DataOutputStream(os);
        dos.writeInt(payload.length); // 4B 大端长度前缀
        dos.write(payload);
        dos.flush();
    }

    private static JSONObject helloJson(String myId, String session) throws IOException {
        JSONObject msg = new JSONObject();
        try {
            msg.put("v", 1);
            msg.put("type", "hello");
            msg.put("id", myId);
            msg.put("session", session);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        return msg;
    }

    private static JSONObject signalJson(String kind, String sdp) throws IOException {
        JSONObject msg = new JSONObject();
        try {
            msg.put("v", 1);
            msg.put("type", "signal");
            msg.put("kind", kind);
            msg.put("sdp", sdp);
        } catch (JSONException e) {
            throw new IOException(e);
        }
        return msg;
    }

    private void emitSignalingError(String peerId, String code, String message) {
        JSObject evt = new JSObject();
        if (peerId != null) evt.put("peerId", peerId);
        evt.put("code", code);
        evt.put("message", message);
        notifyListeners("signalingError", evt);
    }

    private static JSObject idObj(String id) {
        JSObject o = new JSObject();
        o.put("id", id);
        return o;
    }

    private static JSObject startFail(String code) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", code);
        return o;
    }

    private static void closeQuietly(Socket socket) {
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
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
        switch (call.getMethodName()) {
            case "startAdvertising":
                startAdvertisingInternal(call);
                break;
            case "startSignalingServer":
                startSignalingServerInternal(call);
                break;
            default:
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
            if (signalingServer != null) {
                try {
                    signalingServer.close();
                } catch (IOException ignored) {
                }
                signalingServer = null;
            }
            synchronized (this) {
                for (ChannelContext ctx : channels.values()) {
                    closeQuietly(ctx.socket);
                }
                channels.clear();
                for (ChannelContext ctx : outboundPending.values()) {
                    closeQuietly(ctx.socket);
                }
                outboundPending.clear();
            }
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

    /** 成功载荷 {ok:true}（嵌入 call.resolve 的便捷形态） */
    private static JSObject okObj() {
        JSObject o = new JSObject();
        o.put("ok", true);
        return o;
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
