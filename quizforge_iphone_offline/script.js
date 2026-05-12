const PREFERRED_COUNT_KEY = "preferred-question-count";
const USER_QUIZZES_KEY = "quizforge-user-quizzes-v2";
const DB_NAME = "quizforge-db";
const STORE_NAME = "folder";
const HANDLE_KEY = "memory-folder";

const app = document.getElementById("app");
const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const state = {
  folderHandle: null,
  folderName: "",
  library: [],
  selectedQuiz: null,
  session: null
};

startApp();

async function startApp() {
  try {
    if (supportsFolderAccess() && window.indexedDB) {
      state.folderHandle = await loadFolderHandle();

      if (state.folderHandle) {
        try {
          const ok = await verifyPermission(state.folderHandle, false);
          if (ok) {
            state.folderName = state.folderHandle.name;
          }
        } catch {
          state.folderHandle = null;
          state.folderName = "";
        }
      }
    }

    await refreshLibrary();
  } catch (error) {
    console.warn("Startup warning:", error);
  } finally {
    renderHome();
  }
}

function supportsFolderAccess() {
  return "showDirectoryPicker" in window;
}

function isIOSLike() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function getPreferredCount() {
  return Number(localStorage.getItem(PREFERRED_COUNT_KEY)) || 25;
}

function setPreferredCount(value) {
  localStorage.setItem(PREFERRED_COUNT_KEY, String(value));
}

function getUserQuizzes() {
  try {
    return JSON.parse(localStorage.getItem(USER_QUIZZES_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveUserQuizzes(quizzes) {
  localStorage.setItem(USER_QUIZZES_KEY, JSON.stringify(quizzes));
}

function upsertUserQuiz(fileName, text) {
  const quizzes = getUserQuizzes();
  const displayName = removeTxt(fileName);
  const item = {
    id: `local:${fileName}`,
    fileName,
    displayName,
    text,
    updatedAt: Date.now()
  };

  const index = quizzes.findIndex(q => q.fileName === fileName);
  if (index >= 0) quizzes[index] = item;
  else quizzes.push(item);

  saveUserQuizzes(quizzes);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFolderHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFolderHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function verifyPermission(handle, write = false) {
  const options = write ? { mode: "readwrite" } : { mode: "read" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  if ((await handle.requestPermission(options)) === "granted") return true;
  return false;
}

async function chooseMemoryFolder() {
  if (!supportsFolderAccess()) {
    showToast("iPhone/Safari không hỗ trợ chọn folder. Dùng Import File để lưu offline.");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const ok = await verifyPermission(handle, true);
    if (!ok) return showToast("Folder permission denied.");

    state.folderHandle = handle;
    state.folderName = handle.name;
    await saveFolderHandle(handle);
    await refreshLibrary();
    showToast(`Memory folder selected: ${handle.name}`);
    renderHome();
  } catch (error) {
    if (error.name !== "AbortError") showToast(error.message);
  }
}

async function refreshLibrary() {
  const quizzes = [];

  for (const item of (window.BUILTIN_QUIZZES || [])) {
    try {
      const questions = parseQuizText(item.text);
      quizzes.push({
        id: `built-in:${item.fileName}`,
        source: "Built-in",
        fileName: item.fileName,
        displayName: item.displayName || removeTxt(item.fileName),
        questions,
        totalQuestions: questions.length
      });
    } catch (error) {
      console.warn(`Cannot load built-in ${item.fileName}:`, error.message);
    }
  }

  for (const item of getUserQuizzes()) {
    try {
      const questions = parseQuizText(item.text);
      quizzes.push({
        id: item.id || `local:${item.fileName}`,
        source: "Saved on this iPhone/browser",
        fileName: item.fileName,
        displayName: item.displayName || removeTxt(item.fileName),
        questions,
        totalQuestions: questions.length
      });
    } catch (error) {
      console.warn(`Cannot load saved ${item.fileName}:`, error.message);
    }
  }

  if (state.folderHandle && supportsFolderAccess()) {
    const ok = await verifyPermission(state.folderHandle, false);
    if (ok) {
      for await (const [name, handle] of state.folderHandle.entries()) {
        if (handle.kind !== "file" || !name.toLowerCase().endsWith(".txt")) continue;
        try {
          const file = await handle.getFile();
          const text = await file.text();
          const questions = parseQuizText(text);
          quizzes.push({
            id: `folder:${name}`,
            source: "Folder",
            fileName: name,
            displayName: removeTxt(name),
            questions,
            totalQuestions: questions.length
          });
        } catch (error) {
          console.warn(`Cannot load ${name}:`, error.message);
        }
      }
    }
  }

  state.library = quizzes.sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

async function importFileToMemory(file) {
  try {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      showToast("Only .txt files are allowed.");
      return;
    }

    const text = await file.text();
    const questions = parseQuizText(text);

    if (state.folderHandle && supportsFolderAccess()) {
      const ok = await verifyPermission(state.folderHandle, true);
      if (ok) {
        const fileHandle = await state.folderHandle.getFileHandle(file.name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
      }
    }

    upsertUserQuiz(file.name, text);
    await refreshLibrary();
    showToast(`Saved ${file.name} with ${questions.length} questions.`);
    renderLibrary();
  } catch (error) {
    showToast(error.message);
  }
}

function parseQuizText(text) {
  const blocks = text.match(/\{[\s\S]*?\}/g) || [];
  if (blocks.length === 0) throw new Error("No question blocks found.");

  return blocks.map((block, index) => {
    const questionMatch = block.match(/Question:\s*["“]([\s\S]*?)["”]\s*(?:\n|$)/i);
    const answerMatch = block.match(/Answer:\s*(\d+)/i);
    const choiceMatches = [...block.matchAll(/Choice\s+(\d+):\s*["“]([\s\S]*?)["”]\s*(?:\n|$)/gi)];

    if (!questionMatch) throw new Error(`Missing Question in block ${index + 1}.`);
    if (choiceMatches.length < 2) throw new Error(`Block ${index + 1} needs at least 2 choices.`);
    if (!answerMatch) throw new Error(`Missing Answer in block ${index + 1}.`);

    const choices = choiceMatches
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(match => match[2].trim());

    const answer = Number(answerMatch[1]) - 1;
    if (answer < 0 || answer >= choices.length) {
      throw new Error(`Answer in block ${index + 1} is invalid.`);
    }

    return { question: questionMatch[1].trim(), choices, answer };
  });
}

function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function shuffleChoices(question) {
  const withFlag = question.choices.map((choice, index) => ({ text: choice, correct: index === question.answer }));
  const shuffled = shuffleArray(withFlag);
  return {
    question: question.question,
    choices: shuffled.map(item => item.text),
    correctAnswer: shuffled.findIndex(item => item.correct),
    userAnswer: null
  };
}

function createSession(quiz, count) {
  return {
    quizName: quiz.displayName,
    currentIndex: 0,
    questions: shuffleArray(quiz.questions).slice(0, count).map(shuffleChoices)
  };
}

function renderHome() {
  const modeText = supportsFolderAccess() && state.folderHandle
    ? `Folder: ${escapeHtml(state.folderName)}`
    : isIOSLike()
      ? "iPhone offline mode"
      : "Browser offline mode";

  app.innerHTML = `
    <section class="hero">
      <div>
        <h1>QuizForge</h1>
        <p>Offline quiz app. Built-in quizzes + imported .txt files saved on this device.</p>
      </div>
      <div class="badge">${modeText}</div>
    </section>

    <section class="grid">
      <button class="card-btn" id="chooseFolderBtn">
        <span class="icon">📁</span>
        <h2>${supportsFolderAccess() ? "Choose Memory Folder" : "Folder unavailable"}</h2>
        <p>${supportsFolderAccess() ? "Desktop mode: read .txt from a folder." : "iPhone không cho web app giữ folder thật."}</p>
      </button>

      <div class="card-btn" id="importCard">
        <input id="fileInput" type="file" accept=".txt,text/plain" hidden />
        <span class="icon">＋</span>
        <h2>Import File</h2>
        <p>Import a .txt quiz and save it offline on this device.</p>
      </div>

      <button class="card-btn" id="libraryBtn">
        <span class="icon">📚</span>
        <h2>My Library</h2>
        <p>${state.library.length} quizzes available.</p>
      </button>
    </section>

    <section class="panel install-note">
      <h2>iPhone install</h2>
      <p>Open this page in Safari → Share → Add to Home Screen. After the first load, it can open offline.</p>
    </section>
  `;

  document.getElementById("chooseFolderBtn").addEventListener("click", chooseMemoryFolder);
  document.getElementById("libraryBtn").addEventListener("click", async () => {
    await refreshLibrary();
    renderLibrary();
  });

  const importCard = document.getElementById("importCard");
  const fileInput = document.getElementById("fileInput");
  importCard.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", event => {
    const file = event.target.files[0];
    if (file) importFileToMemory(file);
    event.target.value = "";
  });

  importCard.addEventListener("dragover", event => {
    event.preventDefault();
    importCard.classList.add("drag-over");
  });
  importCard.addEventListener("dragleave", () => importCard.classList.remove("drag-over"));
  importCard.addEventListener("drop", event => {
    event.preventDefault();
    importCard.classList.remove("drag-over");
    const file = event.dataTransfer.files[0];
    if (file) importFileToMemory(file);
  });
}

function renderLibrary() {
  app.innerHTML = `
    <div class="top-row">
      <div>
        <h1>My Library</h1>
        <p>Built-in quizzes and imported files saved offline.</p>
      </div>
      <div class="btn-row">
        <button class="secondary" id="refreshBtn">Refresh</button>
        <button class="ghost" id="homeBtn">Home</button>
      </div>
    </div>

    <section class="panel">
      ${state.library.length ? `
        <div class="quiz-list">
          ${state.library.map(quiz => `
            <button class="quiz-item" data-id="${escapeHtml(quiz.id)}">
              <h3>${escapeHtml(quiz.displayName)}</h3>
              <p>${quiz.totalQuestions} questions · ${escapeHtml(quiz.source || "Offline")} · ${escapeHtml(quiz.fileName)}</p>
            </button>
          `).join("")}
        </div>
      ` : `
        <div class="empty">
          <h2>No quizzes found</h2>
          <p>Import a .txt quiz file first.</p>
        </div>
      `}
    </section>
  `;

  document.getElementById("homeBtn").addEventListener("click", renderHome);
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    await refreshLibrary();
    showToast("Library refreshed.");
    renderLibrary();
  });

  document.querySelectorAll(".quiz-item").forEach(button => {
    button.addEventListener("click", () => {
      const quiz = state.library.find(item => item.id === button.dataset.id);
      if (!quiz) return;
      state.selectedQuiz = quiz;
      renderSetup();
    });
  });
}

function renderSetup() {
  const quiz = state.selectedQuiz;
  if (!quiz) return renderLibrary();

  const max = Math.min(50, quiz.totalQuestions);
  const value = Math.min(getPreferredCount(), max);

  app.innerHTML = `
    <button class="secondary" id="backBtn">← Back</button>
    <section class="setup-card">
      <h2>${escapeHtml(quiz.displayName)}</h2>
      <p>${quiz.totalQuestions} questions available</p>
      <div class="slider-line">
        <div class="slider-head"><span>Number of questions</span><strong id="sliderValue">${value}</strong></div>
        <input id="questionSlider" type="range" min="1" max="${max}" value="${value}" />
        <p>Max for this quiz: ${max}</p>
      </div>
      <button class="primary" id="startBtn">Start Quiz</button>
    </section>
  `;

  const slider = document.getElementById("questionSlider");
  const sliderValue = document.getElementById("sliderValue");
  slider.addEventListener("input", () => {
    sliderValue.textContent = slider.value;
    setPreferredCount(Number(slider.value));
  });
  document.getElementById("backBtn").addEventListener("click", renderLibrary);
  document.getElementById("startBtn").addEventListener("click", () => {
    const count = Number(slider.value);
    setPreferredCount(count);
    state.session = createSession(quiz, count);
    renderQuiz();
  });
}

function renderQuiz() {
  const session = state.session;
  if (!session) return renderLibrary();

  const current = session.questions[session.currentIndex];
  const total = session.questions.length;
  const currentNumber = session.currentIndex + 1;
  const progress = (currentNumber / total) * 100;
  const isLast = session.currentIndex === total - 1;

  app.innerHTML = `
    <section class="quiz-shell">
      <div class="top-row">
        <div><h2>${escapeHtml(session.quizName)}</h2><p>Question ${currentNumber} / ${total}</p></div>
        <button class="ghost" id="quitBtn">Quit</button>
      </div>
      <div class="progress"><div class="progress-fill" style="width: ${progress}%"></div></div>
      <article class="question-card">
        <h2>${escapeHtml(current.question)}</h2>
        <div class="choice-list">
          ${current.choices.map((choice, index) => `
            <button class="choice-btn ${current.userAnswer === index ? "selected" : ""}" data-answer="${index}">
              <span class="letter">${letters[index]}</span><span>${escapeHtml(choice)}</span>
            </button>
          `).join("")}
        </div>
      </article>
      <div class="quiz-nav">
        <button class="secondary" id="prevBtn" ${session.currentIndex === 0 ? "disabled" : ""}>Previous</button>
        <button class="primary" id="nextBtn">${isLast ? "Finish" : "Next"}</button>
      </div>
    </section>
  `;

  document.querySelectorAll(".choice-btn").forEach(button => {
    button.addEventListener("click", () => {
      current.userAnswer = Number(button.dataset.answer);
      renderQuiz();
    });
  });
  document.getElementById("quitBtn").addEventListener("click", () => {
    if (confirm("Quit this quiz?")) {
      state.session = null;
      renderLibrary();
    }
  });
  document.getElementById("prevBtn").addEventListener("click", () => {
    if (session.currentIndex > 0) {
      session.currentIndex--;
      renderQuiz();
    }
  });
  document.getElementById("nextBtn").addEventListener("click", () => {
    if (current.userAnswer === null) return showToast("Choose an answer first.");
    if (isLast) renderResult();
    else {
      session.currentIndex++;
      renderQuiz();
    }
  });
}

function renderResult() {
  const session = state.session;
  const correct = session.questions.filter(q => q.userAnswer === q.correctAnswer).length;
  const total = session.questions.length;
  const percent = Math.round((correct / total) * 100);

  app.innerHTML = `
    <section class="result-card">
      <h2>Result</h2>
      <p>${escapeHtml(session.quizName)}</p>
      <div class="score">${correct} / ${total}</div>
      <p>${percent}% correct</p>
      <div class="btn-row">
        <button class="primary" id="reviewBtn">View Details</button>
        <button class="secondary" id="againBtn">Try Again</button>
        <button class="ghost" id="homeBtn">Home</button>
      </div>
    </section>
  `;

  document.getElementById("reviewBtn").addEventListener("click", renderReview);
  document.getElementById("againBtn").addEventListener("click", renderSetup);
  document.getElementById("homeBtn").addEventListener("click", () => {
    state.session = null;
    renderHome();
  });
}

function renderReview() {
  const session = state.session;

  app.innerHTML = `
    <div class="top-row">
      <div><h1>Review</h1><p>${escapeHtml(session.quizName)}</p></div>
      <div class="btn-row"><button class="secondary" id="resultBtn">Back Result</button><button class="ghost" id="homeBtn">Home</button></div>
    </div>
    <section class="review-list">
      ${session.questions.map((q, index) => {
        const isCorrect = q.userAnswer === q.correctAnswer;
        const userAnswer = q.userAnswer === null ? "No answer" : `${letters[q.userAnswer]}. ${escapeHtml(q.choices[q.userAnswer])}`;
        const correctAnswer = `${letters[q.correctAnswer]}. ${escapeHtml(q.choices[q.correctAnswer])}`;
        return `
          <article class="review-card ${isCorrect ? "correct" : "wrong"}">
            <h2>Question ${index + 1}</h2>
            <p>${escapeHtml(q.question)}</p>
            <p>Your answer: <span class="${isCorrect ? "good" : "bad"}">${userAnswer} ${isCorrect ? "✅" : "❌"}</span></p>
            <p>Correct answer: <span class="good">${correctAnswer} ✅</span></p>
          </article>
        `;
      }).join("")}
    </section>
  `;

  document.getElementById("resultBtn").addEventListener("click", renderResult);
  document.getElementById("homeBtn").addEventListener("click", () => {
    state.session = null;
    renderHome();
  });
}

function removeTxt(name) {
  return name.replace(/\.txt$/i, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}
