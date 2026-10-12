import Phaser from "phaser";
import { advance, collect, hireWorker, incomePerSecond, parseSave, upgradeCost, upgradeWorkshop, workerCost } from "./game/engine";
import { WorkshopScene } from "./game/WorkshopScene";
import "./style.css";

const SAVE_KEY = "__PROJECT_NAME__:save:v1";
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root");
app.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="Мастерская, главная"><span class="brand-icon">◈</span> __PROJECT_NAME__ <span class="brand-type">IDLE / 2D</span></a>
    <span class="live-pill"><i></i> Мастерская открыта</span>
  </header>
  <section class="intro"><div><span class="eyebrow">ВАШ МАЛЕНЬКИЙ БОЛЬШОЙ МИР</span><h1>Из искры — целый мир.</h1><p>Собирайте кристаллы, нанимайте помощников и развивайте производство.</p></div><span class="chapter">ГЛАВА 01<br><strong>Начало пути</strong></span></section>
  <section class="dashboard" aria-label="Производство">
    <div class="stage-card"><div class="stage-heading"><span><i class="dot"></i> МАСТЕРСКАЯ</span><span id="level-label">УРОВЕНЬ 01</span></div><div id="game" aria-label="Двухмерный цех. Нажмите на кристалл, чтобы собрать ресурсы."></div><div class="stage-footer"><span>Производство продолжается в фоне</span><span>↗ До 8 часов офлайн</span></div></div>
    <aside class="control-panel"><div class="balance-label">НА ВАШЕМ СКЛАДЕ</div><div class="balance"><span id="credits">12</span><span class="crystal">◈</span></div><div class="rate"><span class="dot"></span><span id="rate">+1.0</span> кристаллов / сек</div><button id="collect" class="collect-button"><span>◈ Собрать кристалл</span><kbd>ПРОБЕЛ</kbd></button><p class="hint">Каждый клик приближает к следующему открытию.</p><div class="divider"></div><span class="eyebrow">РАЗВИТИЕ</span><button id="hire" class="upgrade-card"><span class="upgrade-icon">♟</span><span class="upgrade-info"><strong>Помощник</strong><small>+1 кристалл в секунду</small><span id="workers-label">В команде: 1</span></span><span class="cost" id="hire-cost">25 ◈</span></button><button id="upgrade" class="upgrade-card"><span class="upgrade-icon">⚙</span><span class="upgrade-info"><strong>Улучшить мастерскую</strong><small>Усилить каждый источник</small><span id="upgrade-label">Текущий уровень: 1</span></span><span class="cost" id="upgrade-cost">60 ◈</span></button><p id="feedback" class="feedback" role="status" aria-live="polite">Первый помощник уже приступил к работе.</p></aside>
  </section>
  <section class="overview"><div><span>Всего собрано</span><strong id="total">0 ◈</strong></div><div><span>Помощники</span><strong id="workers">01</strong></div><div><span>Мастерская</span><strong id="level">Уровень 01</strong></div><div><span>Сохранение</span><strong id="save-status">На этом устройстве</strong></div></section>
  <footer><span>НЕБОЛЬШИЕ ШАГИ. БОЛЬШИЕ ОТКРЫТИЯ.</span><span>Прогресс сохраняется автоматически</span></footer>
`;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node as T;
}
const feedback = element("feedback");
let saved: string | null = null;
try { saved = localStorage.getItem(SAVE_KEY); } catch { /* Storage can be disabled; the game remains playable. */ }
const state = parseSave(saved);
const offlineEarned = advance(state);
if (offlineEarned >= 1) feedback.textContent = `Пока вас не было, команда собрала ${format(offlineEarned)} кристаллов.`;
else if (saved) feedback.textContent = "Команда продолжает работу. Прогресс восстановлен.";

function format(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: value < 1000 ? 1 : 0, notation: value >= 100000 ? "compact" : "standard" }).format(value);
}

const scene = new WorkshopScene(manualCollect);
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 1000,
  height: 620,
  backgroundColor: "#18221d",
  scene,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true, roundPixels: true },
});

function manualCollect(): void {
  advance(state);
  const earned = collect(state);
  scene.pulse(earned);
  render();
}

function render(): void {
  element("credits").textContent = format(state.credits);
  element("rate").textContent = `+${format(incomePerSecond(state))}`;
  element("total").textContent = `${format(state.totalEarned)} ◈`;
  element("workers").textContent = String(state.workers).padStart(2, "0");
  element("level").textContent = `Уровень ${String(state.level + 1).padStart(2, "0")}`;
  element("level-label").textContent = `УРОВЕНЬ ${String(state.level + 1).padStart(2, "0")}`;
  element("hire-cost").textContent = `${format(workerCost(state))} ◈`;
  element("upgrade-cost").textContent = `${format(upgradeCost(state))} ◈`;
  element("workers-label").textContent = `В команде: ${state.workers}`;
  element("upgrade-label").textContent = `Текущий уровень: ${state.level + 1}`;
  element<HTMLButtonElement>("hire").disabled = state.credits < workerCost(state) || state.workers >= 100;
  element<HTMLButtonElement>("upgrade").disabled = state.credits < upgradeCost(state) || state.level >= 100;
  scene.setLevel(state.level);
}

function save(): void {
  advance(state);
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    element("save-status").textContent = "Сохранено";
  } catch {
    element("save-status").textContent = "Хранилище недоступно";
  }
}

element("collect").addEventListener("click", manualCollect);
element("hire").addEventListener("click", () => {
  advance(state);
  if (hireWorker(state)) { feedback.textContent = "Новый помощник присоединился к команде. Производство ускорилось."; save(); }
  render();
});
element("upgrade").addEventListener("click", () => {
  advance(state);
  if (upgradeWorkshop(state)) { feedback.textContent = "Мастерская улучшена. Каждый клик и каждый помощник приносят больше."; save(); }
  render();
});
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  manualCollect();
});
window.addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.hidden) save(); else { advance(state); render(); } });
setInterval(() => { advance(state); render(); }, 200);
setInterval(save, 5000);
render();
