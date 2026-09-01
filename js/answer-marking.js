// Разметка вариантов ответа после выбора — общая для экзамена и тренировки.
//
// Отдельный модуль, а не по копии в exam.js и training.js: разметка отвечает
// за доступность (незрячий ученик узнаёт, какой вариант верный, только из
// текста), и две копии этого кода неизбежно разъедутся — на одной странице
// подсказка останется, на другой пропадёт.

/** Текст для скринридера: цвет рамки он не читает. */
const CORRECT_NOTE = "Правильный ответ";
const WRONG_NOTE = "Ваш ответ, неверный";

/**
 * Пометить варианты ответа после выбора.
 *
 * Каждой кнопке проставляется не только класс (цвет), но и невидимая
 * подпись: WCAG 1.4.1 запрещает передавать смысл одним лишь цветом, а
 * disabled-кнопки выпадают из обхода по Tab, поэтому вернуться к ним и
 * разобраться постфактум нельзя.
 *
 * @param {HTMLElement} container — список с кнопками ответов
 * @param {number} correctIndex — номер правильного варианта
 * @param {number} chosenIndex — номер выбранного учеником варианта
 */
export function markAnswerButtons(container, correctIndex, chosenIndex) {
  const buttons = [...container.querySelectorAll(".exam__answer")];
  buttons.forEach((button) => {
    button.disabled = true;
    const index = Number(button.dataset.index);
    if (index === correctIndex) {
      button.classList.add("exam__answer--correct");
      appendNote(button, CORRECT_NOTE);
    }
    if (index === chosenIndex && chosenIndex !== correctIndex) {
      button.classList.add("exam__answer--wrong");
      appendNote(button, WRONG_NOTE);
    }
  });
  return buttons;
}

function appendNote(button, text) {
  const note = document.createElement("span");
  note.className = "sr-only";
  note.textContent = ` (${text})`;
  button.append(note);
}
