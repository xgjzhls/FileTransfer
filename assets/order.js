/* ============================================================
   LocalTransfer 教学课程 · 顺序排列练习组件（assets/order.js）
   用法：
     <div class="order" data-order="A,B,C">
       <p class="q">按正确顺序点选：</p>
       <div class="pile">
         <button data-key="A">甲</button>
         <button data-key="C">丙</button>
         <button data-key="B">乙</button>
       </div>
       <div class="build"></div>      ← 已选中的层依次拼在这里
       <p class="feedback"></p>
     </div>
   行为：点中当前步的正确项 → 拼入 build 并继续；点错 →
         显示正确顺序并锁定（fail-fast，让学习者立刻看到标准答案）。
   ============================================================ */
(function () {
  var orders = document.querySelectorAll('.order');
  Array.prototype.forEach.call(orders, function (el) {
    var correct = el.getAttribute('data-order')
      ? el.getAttribute('data-order').split(',').map(function (s) { return s.trim(); })
      : [];
    var buttons = Array.prototype.slice.call(el.querySelectorAll('.pile button'));
    var build = el.querySelector('.build');
    var feedback = el.querySelector('.feedback');
    var done = false;
    var step = 0;

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (done || btn.disabled) return;
        var key = btn.getAttribute('data-key');
        if (key === correct[step]) {
          btn.disabled = true;
          var chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = btn.textContent;
          build.appendChild(chip);
          step++;
          if (step === correct.length) {
            feedback.textContent = '完整协议栈搭好了 ✓';
            feedback.className = 'feedback visible correct';
            done = true;
            el.classList.add('solved');
          } else {
            feedback.textContent = '第 ' + step + ' 层正确，继续。';
            feedback.className = 'feedback visible correct';
          }
        } else {
          feedback.textContent = '顺序不对。正确顺序（顶层 → 底层）：' + correct.join(' → ');
          feedback.className = 'feedback visible wrong';
          done = true;
          el.classList.add('solved');
        }
      });
    });
  });
})();
