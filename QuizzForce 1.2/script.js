const PREFERRED_COUNT_KEY = "preferred-question-count";
const USER_QUIZZES_KEY = "quizforge-user-quizzes-v2";
const HIDDEN_BUILTINS_KEY = "quizforge-hidden-builtins-v1";
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

function getHiddenBuiltIns() {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_BUILTINS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHiddenBuiltIns(fileNames) {
  localStorage.setItem(HIDDEN_BUILTINS_KEY, JSON.stringify([...new Set(fileNames)]));
}

function deleteUserQuiz(fileName) {
  const quizzes = getUserQuizzes().filter(q => q.fileName !== fileName);
  saveUserQuizzes(quizzes);
}

function hideBuiltInQuiz(fileName) {
  saveHiddenBuiltIns([...getHiddenBuiltIns(), fileName]);
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

  function addLibraryItem(item, source, idPrefix) {
    const parsed = parseStudyText(item.text);
    attachQuestionIds(parsed.questions, `${idPrefix}:${item.fileName}`);
    quizzes.push({
      id: `${idPrefix}:${item.fileName}`,
      source,
      fileName: item.fileName,
      displayName: item.displayName || removeTxt(item.fileName),
      questions: parsed.questions,
      flashcards: parsed.flashcards,
      totalQuestions: parsed.questions.length,
      totalFlashcards: parsed.flashcards.length
    });
  }

  const hiddenBuiltIns = getHiddenBuiltIns();
  for (const item of (window.BUILTIN_QUIZZES || [])) {
    if (hiddenBuiltIns.includes(item.fileName)) continue;
    try {
      addLibraryItem(item, "Built-in", "built-in");
    } catch (error) {
      console.warn(`Cannot load built-in ${item.fileName}:`, error.message);
    }
  }

  for (const item of getUserQuizzes()) {
    try {
      const parsed = parseStudyText(item.text);
      const quizId = item.id || `local:${item.fileName}`;
      attachQuestionIds(parsed.questions, quizId);
      quizzes.push({
        id: quizId,
        source: "Saved on this iPhone/browser",
        fileName: item.fileName,
        displayName: item.displayName || removeTxt(item.fileName),
        questions: parsed.questions,
        flashcards: parsed.flashcards,
        totalQuestions: parsed.questions.length,
        totalFlashcards: parsed.flashcards.length
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
          const parsed = parseStudyText(text);
          const quizId = `folder:${name}`;
          attachQuestionIds(parsed.questions, quizId);
          quizzes.push({
            id: quizId,
            source: "Folder",
            fileName: name,
            displayName: removeTxt(name),
            questions: parsed.questions,
            flashcards: parsed.flashcards,
            totalQuestions: parsed.questions.length,
            totalFlashcards: parsed.flashcards.length
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
    const parsed = parseStudyText(text);

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
    const parts = [];
    if (parsed.questions.length) parts.push(`${parsed.questions.length} questions`);
    if (parsed.flashcards.length) parts.push(`${parsed.flashcards.length} flashcards`);
    showToast(`Saved ${file.name} with ${parts.join(" + ")}.`);
    renderLibrary();
  } catch (error) {
    showToast(error.message);
  }
}


function parseStudyText(text) {
  const blocks = text.match(/\{[\s\S]*?\}/g) || [];
  if (blocks.length === 0) throw new Error("No blocks found.");

  const questions = [];
  const flashcards = [];

  blocks.forEach((block, index) => {
    const questionMatch = block.match(/Question:\s*["“]([\s\S]*?)["”]\s*(?:\n|$)/i);
    const titleMatch = block.match(/(?:Flashcard|Title|Term):\s*["“]([\s\S]*?)["”]\s*(?:;|\n|$)/i);
    const definitionMatch = block.match(/Definition:\s*["“]([\s\S]*?)["”]\s*(?:;|\n|$)/i);

    if (questionMatch) {
      const answerMatch = block.match(/Answer:\s*(\d+)/i);
      const choiceMatches = [...block.matchAll(/Choice\s+(\d+):\s*["“]([\s\S]*?)["”]\s*(?:\n|$)/gi)];

      if (choiceMatches.length < 2) throw new Error(`Block ${index + 1} needs at least 2 choices.`);
      if (!answerMatch) throw new Error(`Missing Answer in block ${index + 1}.`);

      const choices = choiceMatches
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(match => match[2].trim());

      const answer = Number(answerMatch[1]) - 1;
      if (answer < 0 || answer >= choices.length) {
        throw new Error(`Answer in block ${index + 1} is invalid.`);
      }

      questions.push({ question: questionMatch[1].trim(), choices, answer });
      return;
    }

    if (titleMatch && definitionMatch) {
      flashcards.push({
        title: titleMatch[1].trim(),
        definition: definitionMatch[1].trim()
      });
      return;
    }

    throw new Error(`Block ${index + 1} must contain either Question/Choice/Answer or Flashcard/Definition.`);
  });

  if (questions.length === 0 && flashcards.length === 0) {
    throw new Error("No questions or flashcards found.");
  }

  return { questions, flashcards };
}

function parseQuizText(text) {
  const parsed = parseStudyText(text);
  if (parsed.questions.length === 0) throw new Error("No question blocks found.");
  return parsed.questions;
}

function attachQuestionIds(questions, quizId) {
  questions.forEach((question, index) => {
    question.id = `${quizId}#q${index}`;
    question.originalIndex = index;
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
    id: question.id,
    originalIndex: question.originalIndex,
    question: question.question,
    choices: shuffled.map(item => item.text),
    correctAnswer: shuffled.findIndex(item => item.correct),
    userAnswer: null
  };
}

function makeQuizRound(quiz, questionIds, usedQuestionIds = questionIds, preferredCount = questionIds.length) {
  return {
    quizId: quiz.id,
    quizName: quiz.displayName,
    currentIndex: 0,
    preferredCount,
    currentQuestionIds: [...questionIds],
    usedQuestionIds: [...new Set(usedQuestionIds)],
    questions: questionIds
      .map(id => quiz.questions.find(question => question.id === id))
      .filter(Boolean)
      .map(shuffleChoices)
  };
}

function createSession(quiz, count) {
  const picked = shuffleArray(quiz.questions).slice(0, count).map(q => q.id);
  return makeQuizRound(quiz, picked, picked, count);
}

function findQuizBySession(session) {
  return state.library.find(quiz => quiz.id === session.quizId || quiz.displayName === session.quizName);
}

function retryCurrentQuiz() {
  const session = state.session;
  const quiz = session && findQuizBySession(session);
  if (!session || !quiz) return renderLibrary();
  state.session = makeQuizRound(quiz, session.currentQuestionIds, session.usedQuestionIds, session.preferredCount);
  renderQuiz();
}

function continueQuizSession() {
  const session = state.session;
  const quiz = session && findQuizBySession(session);
  if (!session || !quiz) return renderLibrary();

  const used = new Set(session.usedQuestionIds);
  const remaining = quiz.questions.filter(question => !used.has(question.id));

  if (remaining.length === 0) {
    showToast("You finished all questions in this file.");
    return;
  }

  const count = Math.min(session.preferredCount || session.currentQuestionIds.length, remaining.length);
  const nextIds = shuffleArray(remaining).slice(0, count).map(q => q.id);
  state.session = makeQuizRound(quiz, nextIds, [...used, ...nextIds], session.preferredCount || count);
  renderQuiz();
}

function restartQuizFromBeginning() {
  const session = state.session;
  const quiz = session && findQuizBySession(session);
  if (!session || !quiz) return renderLibrary();
  state.session = createSession(quiz, Math.min(session.preferredCount || getPreferredCount(), quiz.totalQuestions));
  renderQuiz();
}


function createFlashcardSession(quiz, count) {
  return {
    quizName: quiz.displayName,
    currentIndex: 0,
    revealed: false,
    cards: shuffleArray(quiz.flashcards || []).slice(0, count)
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

async function deleteLibraryItem(quiz) {
  try {
    if (quiz.id.startsWith("built-in:")) {
      hideBuiltInQuiz(quiz.fileName);
    } else {
      deleteUserQuiz(quiz.fileName);

      if (state.folderHandle && supportsFolderAccess()) {
        const ok = await verifyPermission(state.folderHandle, true);
        if (ok) {
          try {
            await state.folderHandle.removeEntry(quiz.fileName);
          } catch (error) {
            if (error.name !== "NotFoundError") throw error;
          }
        }
      }
    }

    await refreshLibrary();
    showToast(`Deleted ${quiz.displayName}.`);
    renderLibrary();
  } catch (error) {
    showToast(error.message || "Cannot delete this file.");
  }
}

function setupSwipeToDelete(item) {
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let dragging = false;
  let swiping = false;
  let pointerId = null;

  const quiz = state.library.find(entry => entry.id === item.dataset.id);
  if (!quiz) return;

  function resetItem() {
    item.style.transition = "transform 0.18s ease, background 0.18s ease, border-color 0.18s ease";
    item.style.transform = "translateX(0)";
    item.style.setProperty("--delete-progress", "0");
    item.classList.remove("swiping", "delete-ready");
  }

  item.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    currentX = 0;
    dragging = true;
    swiping = false;
    pointerId = event.pointerId;
    item.style.transition = "none";
  });

  item.addEventListener("pointermove", event => {
    if (!dragging || event.pointerId !== pointerId) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!swiping && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (!swiping && Math.abs(dy) > Math.abs(dx)) {
      dragging = false;
      resetItem();
      return;
    }

    if (dx <= 0) {
      currentX = 0;
      resetItem();
      return;
    }

    swiping = true;
    item.setPointerCapture?.(event.pointerId);
    event.preventDefault();

    const thresholdRatio = window.innerWidth >= 700 ? 0.25 : 0.70;
    const threshold = item.offsetWidth * thresholdRatio;
    const progress = Math.min(dx / threshold, 1);
    currentX = Math.min(dx, item.offsetWidth);

    item.classList.add("swiping");
    item.classList.toggle("delete-ready", progress >= 1);
    item.style.transform = `translateX(${currentX}px)`;
    item.style.setProperty("--delete-progress", progress.toFixed(3));
  });

  item.addEventListener("pointerup", async event => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;

    const thresholdRatio = window.innerWidth >= 700 ? 0.25 : 0.70;
    const threshold = item.offsetWidth * thresholdRatio;

    if (swiping && currentX >= threshold) {
      item.style.transition = "transform 0.2s ease, opacity 0.18s ease";
      item.style.transform = `translateX(${item.offsetWidth + 80}px)`;
      item.style.opacity = "0";
      setTimeout(() => deleteLibraryItem(quiz), 180);
    } else {
      resetItem();
    }
  });

  item.addEventListener("pointercancel", () => {
    dragging = false;
    resetItem();
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
            <button class="quiz-item" data-id="${escapeHtml(quiz.id)}" style="--delete-progress: 0">
              <span class="delete-cue" aria-hidden="true">🗑 Delete</span>
              <span class="quiz-item-content">
                <h3>${escapeHtml(quiz.displayName)}</h3>
                <p>${quiz.totalQuestions} questions · ${quiz.totalFlashcards || 0} flashcards · ${escapeHtml(quiz.source || "Offline")} · ${escapeHtml(quiz.fileName)}</p>
              </span>
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
    setupSwipeToDelete(button);
    button.addEventListener("click", () => {
      if (Number(button.style.getPropertyValue("--delete-progress") || 0) > 0.02) return;
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

  const questionCount = quiz.totalQuestions || 0;
  const flashcardCount = quiz.totalFlashcards || 0;
  const max = Math.min(50, Math.max(questionCount, flashcardCount, 1));
  const value = Math.min(getPreferredCount(), max);

  app.innerHTML = `
    <button class="secondary" id="backBtn">← Back</button>
    <section class="setup-card">
      <h2>${escapeHtml(quiz.displayName)}</h2>
      <p>${questionCount} questions · ${flashcardCount} flashcards available</p>
      <div class="slider-line">
        <div class="slider-head"><span>Number of items</span><strong id="sliderValue">${value}</strong></div>
        <input id="questionSlider" type="range" min="1" max="${max}" value="${value}" />
        <p>Max: ${max}. Each mode will use only the items available for that mode.</p>
      </div>
      <div class="mode-grid">
        ${questionCount ? `
          <button class="primary mode-btn" id="startBtn">
            <span>Start Quiz</span>
            <small>Tap answer → auto next</small>
          </button>
        ` : ``}
        ${flashcardCount ? `
          <button class="secondary mode-btn" id="flashcardBtn">
            <span>Flashcards</span>
            <small>Tap card → reveal definition</small>
          </button>
        ` : ``}
      </div>
    </section>
  `;

  const slider = document.getElementById("questionSlider");
  const sliderValue = document.getElementById("sliderValue");
  slider.addEventListener("input", () => {
    sliderValue.textContent = slider.value;
    setPreferredCount(Number(slider.value));
  });
  document.getElementById("backBtn").addEventListener("click", renderLibrary);

  const startBtn = document.getElementById("startBtn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      const count = Math.min(Number(slider.value), questionCount);
      setPreferredCount(Number(slider.value));
      state.session = createSession(quiz, count);
      renderQuiz();
    });
  }

  const flashcardBtn = document.getElementById("flashcardBtn");
  if (flashcardBtn) {
    flashcardBtn.addEventListener("click", () => {
      const count = Math.min(Number(slider.value), flashcardCount);
      setPreferredCount(Number(slider.value));
      state.session = createFlashcardSession(quiz, count);
      renderFlashcard();
    });
  }
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
      <div class="quiz-nav single-nav">
        <button class="secondary" id="prevBtn" ${session.currentIndex === 0 ? "disabled" : ""}>Previous</button>
      </div>
    </section>
  `;

  document.querySelectorAll(".choice-btn").forEach(button => {
    button.addEventListener("click", () => {
      current.userAnswer = Number(button.dataset.answer);
      if (isLast) {
        renderResult();
      } else {
        session.currentIndex++;
        renderQuiz();
      }
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

}


function renderFlashcard() {
  const session = state.session;
  if (!session) return renderLibrary();

  const current = session.cards[session.currentIndex];
  const total = session.cards.length;
  const currentNumber = session.currentIndex + 1;
  const progress = (currentNumber / total) * 100;

  app.innerHTML = `
    <section class="quiz-shell">
      <div class="top-row">
        <div><h2>${escapeHtml(session.quizName)}</h2><p>Flashcard ${currentNumber} / ${total}</p></div>
        <button class="ghost" id="quitBtn">Quit</button>
      </div>
      <div class="progress"><div class="progress-fill" style="width: ${progress}%"></div></div>
      <article class="flashcard ${session.revealed ? "revealed" : ""}" id="flashcardBox">
        <div class="flashcard-inner">
          <div class="flashcard-top">
            <span class="flash-label">${session.revealed ? "Definition" : "Flashcard"}</span>
            <span class="flash-pill">Tap to ${session.revealed ? "hide" : "flip"}</span>
          </div>
          <div>
            <h2 class="flash-term">${escapeHtml(current.title)}</h2>
            <div class="flash-divider"></div>
          </div>
          ${session.revealed ? `
            <div class="flash-answer"><strong>Definition:</strong> ${escapeHtml(current.definition)}</div>
          ` : `<p class="tap-hint">Tap the card to reveal the definition.</p>`}
        </div>
      </article>
      <div class="quiz-nav">
        <button class="secondary" id="prevBtn" ${session.currentIndex === 0 ? "disabled" : ""}>Previous</button>
        <button class="primary" id="nextCardBtn">${session.currentIndex === total - 1 ? "Finish" : "Next"}</button>
      </div>
    </section>
  `;

  document.getElementById("flashcardBox").addEventListener("click", () => {
    session.revealed = !session.revealed;
    renderFlashcard();
  });
  document.getElementById("quitBtn").addEventListener("click", () => {
    if (confirm("Quit flashcards?")) {
      state.session = null;
      renderLibrary();
    }
  });
  document.getElementById("prevBtn").addEventListener("click", () => {
    if (session.currentIndex > 0) {
      session.currentIndex--;
      session.revealed = false;
      renderFlashcard();
    }
  });
  document.getElementById("nextCardBtn").addEventListener("click", () => {
    if (session.currentIndex >= total - 1) {
      state.session = null;
      renderSetup();
    } else {
      session.currentIndex++;
      session.revealed = false;
      renderFlashcard();
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
        <button class="secondary" id="retryBtn">Retry Same</button>
        <button class="secondary" id="continueBtn">Continue New</button>
        <button class="ghost" id="restartBtn">Restart</button>
        <button class="ghost" id="homeBtn">Home</button>
      </div>
    </section>
  `;

  document.getElementById("reviewBtn").addEventListener("click", renderReview);
  document.getElementById("retryBtn").addEventListener("click", retryCurrentQuiz);
  document.getElementById("continueBtn").addEventListener("click", continueQuizSession);
  document.getElementById("restartBtn").addEventListener("click", restartQuizFromBeginning);
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
