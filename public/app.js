const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) { if (dv !== null && dv !== undefined) node.dataset[dk] = dv; }
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// Storage can throw in private mode; it only holds conveniences.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  view: store.get("view") ?? (matchMedia("(max-width: 700px)").matches ? "week" : "board"),
  boards: [],
  board: null,
};

const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};
const fmtDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const isDone = (columnName) => /^done$/i.test(columnName.trim());
const isDoing = (columnName) => /^(doing|in progress)$/i.test(columnName.trim());
const isDoToday = (columnName) => /^do today$/i.test(columnName.trim());

function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}

// Cards

// FNV-1a, then the golden angle, so similar names still land on distant hues.
const COLORS = ["wine", "rust", "ochre", "olive", "spruce", "ink", "plum"];
// FNV-1a, so a label keeps the same palette color everywhere.
const labelColor = (s) => {
  let h = 2166136261;
  for (const c of s.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return COLORS[(h >>> 0) % COLORS.length];
};
const chip = (name) => el("span", { class: "chip", dataset: { color: labelColor(name) } }, name);

// A finished task's date is just history, so it isn't flagged as overdue or due today.
function dueBadge(due, finished = false) {
  if (!due) return null;
  const t = today();
  const urgency = finished ? "" : due < t ? "overdue" : due === t ? "today" : "";
  return el("span", { class: `due ${urgency}` }, due === t && !finished ? "Today" : fmtDate(due));
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function repeatLabel(r) {
  if (r.freq === "day") return r.interval > 1 ? `every ${r.interval} days` : "daily";
  if (r.freq === "month") return r.interval > 1 ? `every ${r.interval} months` : "monthly";
  const days = r.weekdays?.map((d) => WEEKDAYS[d]).join(" ");
  return `${r.interval > 1 ? `every ${r.interval} wks` : "weekly"}${days ? ` · ${days}` : ""}`;
}

function cardBody(task, context, finished = false) {
  const done = task.subtasks.filter((s) => s.done).length;
  return [
    el("div", { class: "title" }, task.title),
    el(
      "div",
      { class: "meta" },
      dueBadge(task.due_date, finished),
      task.repeat ? el("span", { title: "Repeats" }, `↻ ${repeatLabel(task.repeat)}`) : null,
      task.subtasks.length ? el("span", {}, `☑ ${done}/${task.subtasks.length}`) : null,
      context ? el("span", {}, context) : null,
      task.labels.map(chip),
    ),
  ];
}

// Board view

function renderBoard() {
  const board = state.board;
  const main = $("#main");
  if (!board) {
    main.replaceChildren(el("p", { class: "empty" }, "No boards yet. Create one with + Board."));
    return;
  }
  const filter = $("#filter").value.trim().toLowerCase();
  const matches = (t) =>
    !filter || t.title.toLowerCase().includes(filter) || t.labels.some((l) => l.toLowerCase().includes(filter));

  const columns = board.columns.map((col) => {
    const list = el(
      "ul",
      { class: "cards", dataset: { list: col.id } },
      col.tasks.filter(matches).map((task) =>
        el(
          "li",
          {
            class: "card",
            dataset: { id: task.id, color: task.color },
            onclick: () => Date.now() - lastDragEnd > 100 && openTask(task.id, board.id),
          },
          cardBody(task, null, isDone(col.name)),
        ),
      ),
    );
    return el(
      "section",
      { class: "column" },
      el(
        "div",
        { class: "column-head" },
        el("h2", { title: "Rename", onclick: guard(() => renameColumn(col)) }, col.name),
        el("span", { class: "count" }, String(col.tasks.length)),
        el("button", { title: "Delete column", "aria-label": `Delete ${col.name}`, onclick: guard(() => deleteColumn(col)) }, "×"),
      ),
      list,
      el("input", {
        class: "add-task",
        placeholder: "+ Add task",
        dataset: { column: col.id },
        onkeydown: guard(async (e) => {
          if (e.key !== "Enter" || !e.target.value.trim()) return;
          await api("POST", `/columns/${col.id}/tasks`, { title: e.target.value.trim() });
          await refresh();
          document.querySelector(`[data-column="${col.id}"]`)?.focus();
        }),
      }),
    );
  });

  main.replaceChildren(
    el("div", { class: "board" }, columns, el("button", { class: "add-column", onclick: guard(addColumn) }, "+ Column")),
  );
  for (const list of main.querySelectorAll(".cards")) {
    // Touch needs a long press to start dragging, so a normal swipe still scrolls between columns.
    Sortable.create(list, {
      group: "tasks",
      animation: 150,
      delay: 200,
      delayOnTouchOnly: true,
      // Pointer-based dragging instead of native HTML5 drag: identical on mouse and touch.
      forceFallback: true,
      ghostClass: "ghost",
      onEnd: onDragEnd,
    });
  }
}

// A drag ends with a click on the card; this keeps that click from opening the dialog.
let lastDragEnd = 0;

function onDragEnd(evt) {
  lastDragEnd = Date.now();
  if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
  const id = evt.item.dataset.id;
  const col = state.board.columns.find((c) => c.id === evt.to.dataset.list);
  // Index against the full column, not just the visible cards, since a filter may hide some.
  const next = evt.item.nextElementSibling?.dataset.id;
  const others = col.tasks.filter((t) => t.id !== id);
  const index = next ? others.findIndex((t) => t.id === next) : others.length;
  guard(async () => {
    try {
      await moveTask(id, { column_id: col.id, index });
    } finally {
      await refresh(); // on failure this snaps the card back
    }
  })();
}

async function addColumn() {
  const name = prompt("Column name")?.trim();
  if (!name) return;
  state.board = await api("POST", `/boards/${state.board.id}/columns`, { name });
  renderBoard();
}

async function renameColumn(col) {
  const name = prompt("Rename column", col.name)?.trim();
  if (!name || name === col.name) return;
  state.board = await api("PATCH", `/columns/${col.id}`, { name });
  renderBoard();
}

async function deleteColumn(col) {
  const n = col.tasks.length;
  if (!confirm(`Delete column "${col.name}"${n ? ` and its ${n} task${n === 1 ? "" : "s"}` : ""}?`)) return;
  state.board = await api("DELETE", `/columns/${col.id}`);
  renderBoard();
}

function renderBoardSelect() {
  const select = $("#board-select");
  select.replaceChildren(...state.boards.map((b) => el("option", { value: b.id, selected: b.id === state.board?.id }, b.name)));
}

// Week view

async function renderWeek() {
  const t = today();
  const end = addDays(t, 7);
  const tasks = (await api("GET", "/tasks")).filter((task) => !isDone(task.column));
  const groups = [
    { title: "Overdue", cls: "overdue", tasks: tasks.filter((x) => x.due_date && x.due_date < t) },
    // A task moved to "Do today" counts as today's whatever its due date, unless it's already overdue.
    { title: "Today", tasks: tasks.filter((x) => x.due_date === t || (isDoToday(x.column) && !(x.due_date && x.due_date < t))) },
    ...Array.from({ length: 7 }, (_, i) => {
      const day = addDays(t, i + 1);
      return { title: fmtDate(day), tasks: tasks.filter((x) => x.due_date === day && !isDoToday(x.column)) };
    }),
    { title: "In progress", tasks: tasks.filter((x) => isDoing(x.column) && (!x.due_date || x.due_date > end)) },
  ].filter((g) => g.tasks.length);

  $("#main").replaceChildren(
    el(
      "div",
      { class: "week" },
      groups.length
        ? groups.map((g) => [
            el("h2", { class: g.cls }, g.title),
            el(
              "ul",
              { class: "cards" },
              g.tasks.map((task) =>
                el(
                  "li",
                  { class: "card", dataset: { color: task.color }, onclick: () => openTask(task.id, task.board_id) },
                  el("button", {
                    class: "check",
                    title: "Mark done",
                    "aria-label": `Mark ${task.title} done`,
                    onclick: guard(async (e) => {
                      e.stopPropagation();
                      await completeTask(task);
                    }),
                  }),
                  el("div", {}, cardBody(task, `${task.board} · ${task.column}`)),
                ),
              ),
            ),
          ])
        : el("p", { class: "empty" }, "Nothing due this week."),
    ),
  );
}

// Moving a recurring task to Done returns the copy the server created for its next occurrence.
async function moveTask(id, body) {
  const moved = await api("POST", `/tasks/${id}/move`, body);
  if (moved.next) toast(`Next "${moved.next.title}" due ${fmtDate(moved.next.due_date)}`);
  return moved;
}

async function completeTask(task) {
  const board = await api("GET", `/boards/${task.board_id}`);
  const target = board.columns.find((c) => isDone(c.name)) ?? board.columns.at(-1);
  const moved = await moveTask(task.id, { column_id: target.id });
  if (!moved.next) toast(`Moved to ${target.name}`);
  await refresh();
}

// Stats view

const SERIES_SLOTS = 4;
const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// The four most active courses get the validated chart colors (in name order, so a course keeps its color
// while it stays in the top four); everything else folds into a grey "Other".
function chartSeries(stats) {
  const activity = (c) => stats.weeks.reduce((n, w) => n + (w.byCourse[c] ?? 0), 0) + (stats.open.byCourse[c]?.open ?? 0);
  const named = stats.courses.filter((c) => c !== "No label").sort((a, b) => activity(b) - activity(a)).slice(0, SERIES_SLOTS).sort();
  const series = named.map((name, i) => ({ name, members: [name], color: `var(--series-${i + 1})` }));
  const rest = stats.courses.filter((c) => !named.includes(c));
  if (rest.length) series.push({ name: "Other", members: rest, color: "var(--series-other)" });
  return series;
}

function tile(label, value, note) {
  return el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), note ? el("div", { class: "note" }, note) : null);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function renderStats() {
  const stats = await api("GET", "/stats");
  const series = chartSeries(stats);
  const { onTime, streak, open } = stats;
  const finished = stats.weeks.reduce((n, w) => n + w.total, 0);
  const chartBox = el("div", { class: "chart" });

  $("#main").replaceChildren(
    el(
      "div",
      { class: "stats" },
      el(
        "div",
        { class: "tiles" },
        tile("Current streak", plural(streak.current, "day"), "days in a row with something finished"),
        tile("Longest streak", plural(streak.longest, "day")),
        tile("On time", onTime.rate === null ? "–" : `${Math.round(onTime.rate * 100)}%`, `${onTime.onTime} of ${onTime.total} with a due date, last 12 weeks`),
        tile("Overdue now", String(open.overdue), `of ${plural(open.total, "open task")}`),
        tile("Due in 7 days", String(open.dueSoon)),
      ),
      el(
        "section",
        {},
        el("h2", {}, "Finished per week"),
        el("p", { class: "sub" }, `${plural(finished, "task")} in the last 12 weeks, by course`),
        finished
          ? [
              el("div", { class: "legend" }, series.map((s) => el("span", {}, el("i", { class: "key", style: `background:${s.color}` }), s.name))),
              chartBox,
              weekTable(stats, series),
            ]
          : el("p", { class: "sub" }, "Nothing finished yet. Move tasks to Done and they'll show up here."),
      ),
      courseTable(stats, series),
    ),
  );
  if (finished) {
    drawWeeks(chartBox, stats, series);
    // Redraw at the new width so axis text stays a readable size instead of scaling with the SVG.
    const ro = new ResizeObserver(() => drawWeeks(chartBox, stats, series));
    ro.observe(chartBox);
    renderStats.cleanup?.();
    renderStats.cleanup = () => ro.disconnect();
  }
}

function weekValues(week, s) {
  return s.members.reduce((n, c) => n + (week.byCourse[c] ?? 0), 0);
}

function drawWeeks(box, stats, series) {
  const SVG = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const W = box.clientWidth;
  if (!W) return;
  const H = 200;
  const pad = { top: 18, right: 4, bottom: 22, left: 28 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...stats.weeks.map((w) => w.total));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const band = plotW / stats.weeks.length;
  const barW = Math.min(24, band * 0.6);
  const labelEvery = band >= 44 ? 1 : band >= 24 ? 2 : 3;
  const root = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Tasks finished per week, stacked by course" });

  for (let v = 0; v <= top; v += step) {
    root.append(svg("line", { class: "grid", x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v) }));
    const t = svg("text", { class: "axis", x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = String(v);
    root.append(t);
  }

  const maxIdx = stats.weeks.reduce((m, w, i, a) => (w.total > a[m].total ? i : m), 0);
  const lastIdx = stats.weeks.length - 1;
  const tip = el("div", { class: "tooltip", hidden: true });

  stats.weeks.forEach((week, i) => {
    const cx = pad.left + band * i + band / 2;
    const x = cx - barW / 2;
    // Hit area: the whole column, so a tap anywhere above the week works.
    const hit = svg("rect", { class: "hit", x: pad.left + band * i, y: pad.top, width: band, height: plotH, rx: 4, tabindex: 0 });
    hit.setAttribute("aria-label", `Week of ${shortDate(week.start)}: ${week.total} finished`);
    root.append(hit);

    const parts = series.map((s) => ({ s, v: weekValues(week, s) })).filter((p) => p.v > 0);
    let acc = 0;
    parts.forEach((p, j) => {
      const y0 = y(acc);
      acc += p.v;
      const y1 = y(acc);
      const gap = j < parts.length - 1 ? 2 : 0; // surface gap between stacked segments
      const h = Math.max(0, y0 - y1 - gap);
      const isTop = j === parts.length - 1;
      const yTop = y1 + gap;
      // Rounded data-end on the top segment only; square at the baseline.
      const r = isTop ? Math.min(4, h, barW / 2) : 0;
      const d = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
      root.append(svg("path", { d, fill: p.s.color, "pointer-events": "none" }));
    });

    if (week.total && (i === maxIdx || i === lastIdx)) {
      const cap = svg("text", { class: "cap", x: cx, y: y(week.total) - 5, "text-anchor": "middle", "pointer-events": "none" });
      cap.textContent = String(week.total);
      root.append(cap);
    }
    // Keep a full label gap before "This week" so the last two labels never collide.
    if ((i % labelEvery === 0 && lastIdx - i >= labelEvery) || i === lastIdx) {
      const t = svg("text", { class: "axis", x: cx, y: H - 6, "text-anchor": "middle" });
      t.textContent = i === lastIdx ? "This week" : shortDate(week.start);
      root.append(t);
    }

    const show = () => {
      tip.replaceChildren(
        el("div", { class: "when" }, `Week of ${shortDate(week.start)}`),
        el("div", { class: "row" }, el("b", {}, String(week.total)), "finished"),
        ...series
          .map((s) => ({ s, v: weekValues(week, s) }))
          .filter((p) => p.v)
          .map((p) => el("div", { class: "row" }, el("i", { class: "line", style: `background:${p.s.color}` }), el("b", {}, String(p.v)), p.s.name)),
      );
      tip.hidden = false;
      const left = Math.min(Math.max(0, cx - 70), W - tip.offsetWidth);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, y(week.total) - tip.offsetHeight - 8)}px`;
    };
    const hide = () => (tip.hidden = true);
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
  });

  box.replaceChildren(root, tip);
}

function weekTable(stats, series) {
  return el(
    "details",
    {},
    el("summary", {}, "Show as table"),
    el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, el("th", {}, "Week of"), series.map((s) => el("th", { class: "num" }, s.name)), el("th", { class: "num" }, "Total"))),
        el(
          "tbody",
          {},
          stats.weeks.map((w) =>
            el("tr", {}, el("td", {}, shortDate(w.start)), series.map((s) => el("td", { class: "num" }, String(weekValues(w, s)))), el("td", { class: "num" }, String(w.total))),
          ),
        ),
      ),
    ),
  );
}

function courseTable(stats, series) {
  const colorOf = (c) => series.find((s) => s.members.includes(c))?.color ?? "var(--series-other)";
  const rows = stats.courses.map((c) => {
    const ot = stats.onTime.byCourse[c];
    const op = stats.open.byCourse[c] ?? { open: 0, overdue: 0, dueSoon: 0 };
    return el(
      "tr",
      {},
      el("td", {}, el("span", { class: "name" }, el("i", { class: "key", style: `background:${colorOf(c)}` }), c)),
      el("td", { class: "num" }, ot ? `${Math.round((ot.onTime / ot.total) * 100)}% (${ot.onTime}/${ot.total})` : "–"),
      el("td", { class: "num" }, String(op.open)),
      el("td", { class: "num" }, String(op.overdue)),
      el("td", { class: "num" }, String(op.dueSoon)),
    );
  });
  return el(
    "section",
    {},
    el("h2", {}, "By course"),
    el("p", { class: "sub" }, "On-time rate covers the last 12 weeks; the rest is what's open now."),
    el(
      "div",
      { class: "table-scroll" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, el("th", {}, "Course"), el("th", { class: "num" }, "On time"), el("th", { class: "num" }, "Open"), el("th", { class: "num" }, "Overdue"), el("th", { class: "num" }, "Due ≤ 7 days"))),
        el("tbody", {}, rows),
      ),
    ),
  );
}

// Task dialog

const dialog = $("#task-dialog");
const form = $("#task-form");
let editing = null; // { task, board }

async function openTask(taskId, boardId) {
  const [task, board] = await Promise.all([
    api("GET", `/tasks/${taskId}`),
    state.board?.id === boardId ? state.board : api("GET", `/boards/${boardId}`),
  ]);
  editing = { task, board };
  form.title.value = task.title;
  form.due_date.value = task.due_date ?? "";
  form.labels.value = task.labels.join(", ");
  form.color.value = task.color ?? "";
  showRepeat(task.repeat);
  form.notes.value = task.notes;
  form.column.replaceChildren(...board.columns.map((c) => el("option", { value: c.id, selected: c.id === task.column_id }, c.name)));
  renderLinks();
  renderSubtasks(task);
  dialog.showModal();
}

const weekdayBoxes = () => [...form.querySelectorAll('input[name="weekday"]')];
const dueWeekday = () => new Date(`${form.due_date.value || today()}T12:00`).getDay();
const syncWeekdays = () => ($("#weekdays").hidden = !form.repeat.value.startsWith("week"));

function showRepeat(rule) {
  form.repeat.querySelector('option[value="custom"]')?.remove();
  // A rule the menu can't express (e.g. Claude set "every 3 weeks") is kept as-is unless changed.
  const simple = !rule || rule.interval === 1 || (rule.freq === "week" && rule.interval === 2);
  if (!simple) form.repeat.append(el("option", { value: "custom" }, `Custom: ${repeatLabel(rule)}`));
  editing.repeat = rule;
  form.repeat.value = !rule ? "" : !simple ? "custom" : rule.freq === "week" ? (rule.interval === 2 ? "week2" : "week") : rule.freq;
  const days = rule?.weekdays ?? [dueWeekday()];
  weekdayBoxes().forEach((b) => (b.checked = days.includes(Number(b.value))));
  syncWeekdays();
}

function readRepeat() {
  const v = form.repeat.value;
  if (!v) return null;
  if (v === "custom") return editing.repeat;
  if (!v.startsWith("week")) return { freq: v, interval: 1 };
  const days = weekdayBoxes().filter((b) => b.checked).map((b) => Number(b.value));
  return { freq: "week", interval: v === "week2" ? 2 : 1, weekdays: days.length ? days : [dueWeekday()] };
}
form.repeat.addEventListener("change", syncWeekdays);

function renderLinks() {
  const urls = form.notes.value.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  $("#links").replaceChildren(
    ...urls.map((u) =>
      el("a", { href: u, target: "_blank", rel: "noopener" }, /instructure|canvas/.test(u) ? "Open in Canvas ↗" : `${new URL(u).hostname} ↗`),
    ),
  );
}
form.notes.addEventListener("input", renderLinks);

function renderSubtasks(task) {
  editing.task = task;
  $("#subtasks").replaceChildren(
    ...task.subtasks.map((s) =>
      el(
        "li",
        { class: s.done ? "done" : "" },
        el("input", {
          type: "checkbox",
          checked: s.done,
          "aria-label": s.title,
          onchange: guard(async (e) => renderSubtasks(await api("PATCH", `/subtasks/${s.id}`, { done: e.target.checked }))),
        }),
        el("span", {}, s.title),
        el("button", { type: "button", "aria-label": `Delete ${s.title}`, onclick: guard(async () => renderSubtasks(await api("DELETE", `/subtasks/${s.id}`))) }, "×"),
      ),
    ),
  );
}

$("#new-subtask").addEventListener(
  "keydown",
  guard(async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); // Enter would otherwise submit the form
    const title = e.target.value.trim();
    if (!title) return;
    renderSubtasks(await api("POST", `/tasks/${editing.task.id}/subtasks`, { title }));
    e.target.value = "";
  }),
);

dialog.addEventListener(
  "close",
  guard(async () => {
    if (dialog.returnValue === "save") {
      const { task } = editing;
      await api("PATCH", `/tasks/${task.id}`, {
        title: form.title.value.trim(),
        notes: form.notes.value,
        due_date: form.due_date.value || null,
        color: form.color.value || null,
        repeat: readRepeat(),
        labels: form.labels.value.split(","),
      });
      if (form.column.value !== task.column_id) await moveTask(task.id, { column_id: form.column.value });
    }
    dialog.returnValue = "";
    // Subtask edits apply immediately, so refresh even on cancel.
    await refresh();
  }),
);

$("#delete-task").addEventListener(
  "click",
  guard(async () => {
    if (!confirm(`Delete "${editing.task.title}"?`)) return;
    await api("DELETE", `/tasks/${editing.task.id}`);
    dialog.close();
  }),
);

// Shell

async function refresh() {
  renderStats.cleanup?.();
  document.body.dataset.view = state.view;
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.dataset.view === state.view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"),
  );
  if (state.view === "week") return renderWeek();
  if (state.view === "stats") return renderStats();

  state.boards = await api("GET", "/boards");
  const wanted = state.board?.id ?? store.get("board");
  const id = state.boards.find((b) => b.id === wanted)?.id ?? state.boards[0]?.id;
  state.board = id ? await api("GET", `/boards/${id}`) : null;
  if (id) store.set("board", id);
  renderBoardSelect();
  renderBoard();
}

document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener(
    "click",
    guard(async () => {
      state.view = b.dataset.view;
      store.set("view", state.view);
      await refresh();
    }),
  ),
);

$("#board-select").addEventListener(
  "change",
  guard(async (e) => {
    state.board = await api("GET", `/boards/${e.target.value}`);
    store.set("board", state.board.id);
    renderBoard();
  }),
);

$("#new-board").addEventListener(
  "click",
  guard(async () => {
    const name = prompt("Board name")?.trim();
    if (!name) return;
    state.board = await api("POST", "/boards", { name });
    await refresh();
  }),
);

$("#filter").addEventListener("input", renderBoard);

$("#sync").addEventListener(
  "click",
  guard(async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("POST", "/canvas/sync");
      toast(`Canvas: ${r.created} new, ${r.updated} updated`);
      await refresh();
    } finally {
      e.target.disabled = false;
    }
  }),
);

// Pick up changes made elsewhere (e.g. by Claude) when returning to the app.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !dialog.open) guard(refresh)();
});

guard(refresh)();
