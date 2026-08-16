/* ============================================================
   LocalTransfer 教学课程 · 共享测验组件（assets/quiz.js）
   用法：每个 .quiz 容器内
     - .q         题目文本
     - .options li 若干选项（点击作答）
     - .feedback   反馈区（初始为空）
   data 属性：
     - .quiz[data-answer="N"]     正确选项下标（0 起）
     - li[data-feedback="…"]      该选项被点选后显示的说明
   行为：点错 → 标红 + 显示该选项说明，可继续试；
         点对 → 标绿 + 显示说明 + 锁定其余选项。
   同一页多个 .quiz 各自独立。
   ============================================================ */
(function () {
  function initQuiz(quiz) {
    var answer = parseInt(quiz.getAttribute('data-answer'), 10);
    if (isNaN(answer)) return;
    var options = quiz.querySelectorAll('.options li');
    var feedback = quiz.querySelector('.feedback');
    var solved = false;

    function reveal(li, ok, text) {
      li.classList.add(ok ? 'correct' : 'wrong');
      var mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = ok ? '✓' : '✗';
      li.appendChild(mark);
      if (feedback) {
        feedback.textContent = text;
        feedback.className = 'feedback visible ' + (ok ? 'correct' : 'wrong');
      }
    }

    function lockAll() {
      for (var i = 0; i < options.length; i++) {
        options[i].classList.add('locked');
      }
      quiz.classList.add('locked-quiz');
    }

    Array.prototype.forEach.call(options, function (li, idx) {
      li.addEventListener('click', function () {
        if (solved || li.classList.contains('locked')) return;
        var text = li.getAttribute('data-feedback') || '';
        if (idx === answer) {
          solved = true;
          reveal(li, true, text);
          lockAll();
        } else {
          reveal(li, false, text || '再想想。');
        }
      });
    });
  }

  var quizzes = document.querySelectorAll('.quiz');
  Array.prototype.forEach.call(quizzes, initQuiz);
})();
