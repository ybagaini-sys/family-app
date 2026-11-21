const members = {
  Yann: {initial:"Y", cls:"avatar-yann"},
  Delphine: {initial:"D", cls:"avatar-delphine"},
  Olivia: {initial:"O", cls:"avatar-olivia"},
  Amélie: {initial:"A", cls:"avatar-amelie"}
};

let currentMember = "Yann";
const views = ["home","shopping","meals","calendar","tasks"];
const STORAGE_KEY = "family-app-local-v1";
let localData = { shopping: [], tasks: [] };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  if (saved && Array.isArray(saved.shopping) && Array.isArray(saved.tasks)) localData = saved;
} catch (error) { console.warn("Données locales illisibles", error); }

// Les courses sont partagées via Supabase. Les tâches restent locales jusqu'à
// leur raccordement dans une prochaine étape.
let shoppingItems = [];
let shoppingListId = null;
let shoppingFamilyId = null;
let shoppingChannel = null;
let shoppingPoll = null;
let shoppingLoadInProgress = false;

function saveLocalData() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(localData)); }
  catch (error) { showToast("Impossible d'enregistrer sur cet appareil"); }
}
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}
function navigate(view) {
  if (!views.includes(view)) return;
  document.querySelectorAll(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  window.scrollTo({top:0, behavior:"smooth"});
}
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.go)));
function selectMember(name) {
  if (!members[name]) return;
  currentMember = name;
  document.getElementById("welcomeName").textContent = name;
  const profileButton = document.getElementById("profileButton");
  profileButton.textContent = members[name].initial;
  profileButton.className = `avatar ${members[name].cls}`;
  document.querySelectorAll(".member").forEach(button => button.classList.toggle("selected", button.dataset.member === name));
  showToast(`Profil sélectionné : ${name}`);
}
document.querySelectorAll(".member").forEach(button => button.addEventListener("click", () => selectMember(button.dataset.member)));
document.getElementById("profileButton").addEventListener("click", () => showToast(`Profil actif : ${currentMember}`));

// Actualisation manuelle : vérifie le service worker, puis recharge depuis le réseau.
const refreshButton = document.getElementById("refreshAppButton");
if (refreshButton) {
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = "Mise à jour…";
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
          if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
    } catch (error) {
      console.warn("Family-app : vérification de mise à jour impossible", error);
    }
    // Le service worker utilise le réseau en priorité pour les pages et fichiers.
    // Le rechargement récupère donc la version publiée dès qu'elle est disponible.
    window.location.reload();
  });
}

function makeDeleteButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "delete-item"; button.textContent = "Supprimer";
  button.setAttribute("aria-label", `Supprimer ${label}`);
  button.addEventListener("click", handler);
  return button;
}
function getFamilyBridge() {
  return window.familyAppSupabase || null;
}

async function ensureShoppingList(client, familyId) {
  const { data: existing, error: readError } = await client
    .from("shopping_lists")
    .select("id")
    .eq("family_id", familyId)
    .eq("is_archived", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (readError) throw readError;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await client
    .from("shopping_lists")
    .insert({ family_id: familyId, name: "Courses" })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return created.id;
}

async function loadShoppingFromSupabase() {
  const bridge = getFamilyBridge();
  if (!bridge || !shoppingListId) return;
  const client = bridge.client;
  const { data, error } = await client
    .from("shopping_items")
    .select("id, name, is_completed, sort_order, created_at")
    .eq("list_id", shoppingListId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  shoppingItems = data || [];
  renderShopping();
}

async function initializeShoppingSync(familyId) {
  const bridge = getFamilyBridge();
  if (!bridge || !familyId || shoppingLoadInProgress) return;
  if (shoppingFamilyId === familyId && shoppingListId) {
    try { await loadShoppingFromSupabase(); } catch (error) {
      console.error("Actualisation des courses impossible:", error);
      showToast("Impossible d'actualiser les courses");
    }
    return;
  }

  shoppingLoadInProgress = true;
  try {
    if (shoppingChannel) {
      await bridge.client.removeChannel(shoppingChannel);
      shoppingChannel = null;
    }
    if (shoppingPoll) { clearInterval(shoppingPoll); shoppingPoll = null; }

    shoppingFamilyId = familyId;
    shoppingListId = await ensureShoppingList(bridge.client, familyId);

    // Migration unique des articles locaux vers Supabase, uniquement si la
    // liste distante est vide. Cela évite les doublons et préserve les données.
    const migrationKey = `family-app-shopping-migrated:${familyId}`;
    const { data: currentRemote, error: remoteError } = await bridge.client
      .from("shopping_items").select("id").eq("list_id", shoppingListId).limit(1);
    if (remoteError) throw remoteError;
    if (!localStorage.getItem(migrationKey) && (currentRemote || []).length === 0 && localData.shopping.length) {
      const user = bridge.getCurrentUser();
      const rows = localData.shopping.map((item, index) => ({
        list_id: shoppingListId,
        name: String(item.name || "").trim(),
        is_completed: !!item.done,
        added_by: user?.id || undefined,
        sort_order: index
      })).filter(item => item.name);
      if (rows.length) {
        const { error: migrationError } = await bridge.client.from("shopping_items").insert(rows);
        if (migrationError) throw migrationError;
        localData.shopping = [];
        saveLocalData();
        showToast("Vos anciens articles ont été transférés");
      }
      localStorage.setItem(migrationKey, "1");
    } else if (!localStorage.getItem(migrationKey)) {
      // La liste distante contient déjà des données : on ne fusionne pas
      // automatiquement pour ne pas créer de doublons. Les anciennes données
      // locales sont conservées dans le stockage de cet appareil.
      localStorage.setItem(migrationKey, "1");
    }

    await loadShoppingFromSupabase();

    // Realtime pour les changements des autres membres.
    shoppingChannel = bridge.client
      .channel(`family-shopping-${shoppingListId}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "shopping_items",
        filter: `list_id=eq.${shoppingListId}`
      }, () => {
        loadShoppingFromSupabase().catch(error => {
          console.error("Synchronisation temps réel des courses impossible:", error);
        });
      })
      .subscribe();

    // Secours : actualisation périodique si Realtime n'est pas activé dans
    // la publication Supabase du projet.
    shoppingPoll = setInterval(() => {
      loadShoppingFromSupabase().catch(error => console.warn("Actualisation périodique des courses impossible:", error));
    }, 12000);
  } catch (error) {
    console.error("Connexion des courses à Supabase impossible:", error);
    showToast("Courses non synchronisées : vérifiez la connexion");
    shoppingFamilyId = null;
    shoppingListId = null;
  } finally {
    shoppingLoadInProgress = false;
  }
}

function renderShopping() {
  const list = document.getElementById("shoppingList");
  list.replaceChildren();
  shoppingItems.forEach(item => {
    const row = document.createElement("div");
    row.className = `check-row${item.is_completed ? " done" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!item.is_completed;
    checkbox.setAttribute("aria-label", item.is_completed ? `Remettre ${item.name} à acheter` : `Marquer ${item.name} comme acheté`);
    checkbox.addEventListener("change", async () => {
      checkbox.disabled = true;
      const { error } = await getFamilyBridge().client
        .from("shopping_items").update({ is_completed: checkbox.checked }).eq("id", item.id);
      checkbox.disabled = false;
      if (error) { showToast("Modification impossible"); console.error(error); return; }
      await loadShoppingFromSupabase();
    });
    const custom = document.createElement("span");
    custom.className = "check-custom";
    const text = document.createElement("span");
    text.className = "check-text";
    text.textContent = item.name;
    row.append(checkbox, custom, text, makeDeleteButton(item.name, async () => {
      const { error } = await getFamilyBridge().client.from("shopping_items").delete().eq("id", item.id);
      if (error) { showToast("Suppression impossible"); console.error(error); return; }
      await loadShoppingFromSupabase();
      showToast("Article supprimé");
    }));
    list.append(row);
  });
  const count = shoppingItems.filter(item => !item.is_completed).length;
  document.getElementById("shoppingCount").textContent = count ? `${count} article${count > 1 ? "s" : ""} à acheter` : "Aucun article à acheter";
  document.getElementById("shoppingEmpty").classList.toggle("hidden", shoppingItems.length > 0);
  document.getElementById("shoppingSummaryCount").textContent = count;
}

document.getElementById("addShopping").addEventListener("click", () => {
  document.getElementById("shoppingForm").classList.toggle("hidden");
  document.getElementById("shoppingInput").focus();
});
document.getElementById("shoppingForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("shoppingInput");
  const value = input.value.trim();
  if (!value) return;
  const bridge = getFamilyBridge();
  if (!bridge || !shoppingListId) { showToast("La liste familiale n'est pas encore prête"); return; }
  const button = document.querySelector("#shoppingForm button[type=submit]");
  button.disabled = true;
  const { error } = await bridge.client.from("shopping_items").insert({
    list_id: shoppingListId, name: value, is_completed: false, added_by: bridge.getCurrentUser()?.id
  });
  button.disabled = false;
  if (error) { console.error(error); showToast("Ajout impossible : vérifiez la connexion"); return; }
  input.value = "";
  await loadShoppingFromSupabase();
  showToast("Article ajouté à la liste familiale");
});

window.addEventListener("family-app-family-ready", event => {
  initializeShoppingSync(event.detail?.familyId);
});

// Tâches familiales : données centralisées dans Supabase.
let familyTasks = [];
let familyMembers = [];
let taskChannel = null;
let taskPoll = null;
let taskFamilyId = null;
let taskLoading = false;
let taskMembersLoaded = false;

async function loadFamilyTasks() {
  const bridge = getFamilyBridge();
  if (!bridge || !taskFamilyId) return;
  const client = bridge.client;
  const { data: tasks, error: taskError } = await client
    .from("tasks")
    .select("id, family_id, title, description, assignment_type, assigned_to, due_at, status, completed_by, completed_at, created_by, created_at")
    .eq("family_id", taskFamilyId)
    .order("created_at", { ascending: false });
  if (taskError) throw taskError;

  const ids = (tasks || []).map(task => task.id);
  let assignees = [];
  if (ids.length) {
    const { data, error } = await client
      .from("task_assignees")
      .select("task_id, user_id")
      .in("task_id", ids);
    if (error) throw error;
    assignees = data || [];
  }
  familyTasks = (tasks || []).map(task => ({
    ...task,
    assigneeIds: assignees.filter(a => a.task_id === task.id).map(a => a.user_id)
  }));
  renderTasks();
}

function renderTaskAssigneePicker(messageText = "") {
  const target = document.getElementById("taskAssignees");
  if (!target) return;
  target.replaceChildren();
  if (!familyMembers.length) {
    const status = document.createElement("span");
    status.className = "task-assignee-status";
    status.textContent = messageText || (taskMembersLoaded
      ? "Aucun membre trouvé dans ce foyer."
      : "Chargement des membres du foyer…");
    target.append(status);
    return;
  }
  familyMembers.forEach(member => {
    const label = document.createElement("label");
    label.className = "task-assignee-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "taskAssignee";
    checkbox.value = member.user_id;
    const name = document.createElement("span");
    name.textContent = member.display_name;
    label.append(checkbox, name);
    target.append(label);
  });
}

async function initializeTaskSync(familyId) {
  const bridge = getFamilyBridge();
  if (!bridge || !familyId || taskLoading) return;
  if (taskFamilyId === familyId) {
    try { await loadFamilyTasks(); } catch (error) { console.error("Actualisation des tâches impossible:", error); }
    return;
  }
  taskLoading = true;
  renderTaskAssigneePicker("Chargement des membres du foyer…");
  try {
    if (taskChannel) { await bridge.client.removeChannel(taskChannel); taskChannel = null; }
    if (taskPoll) { clearInterval(taskPoll); taskPoll = null; }
    taskFamilyId = familyId;
    const { data: membersData, error: membersError } = await bridge.client
      .from("family_members")
      .select("user_id, display_name")
      .eq("family_id", familyId)
      .order("joined_at", { ascending: true });
    if (membersError) throw membersError;
    familyMembers = membersData || [];
    taskMembersLoaded = true;
    renderTaskAssigneePicker();
    await loadFamilyTasks();

    taskChannel = bridge.client
      .channel(`family-tasks-${familyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `family_id=eq.${familyId}` }, () => {
        loadFamilyTasks().catch(error => console.warn("Realtime tâches:", error));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "task_assignees", filter: `family_id=eq.${familyId}` }, () => {
        loadFamilyTasks().catch(error => console.warn("Realtime attributions:", error));
      })
      .subscribe();
    taskPoll = setInterval(() => loadFamilyTasks().catch(error => console.warn("Actualisation tâches:", error)), 12000);
  } catch (error) {
    console.error("Connexion des tâches à Supabase impossible:", error);
    taskMembersLoaded = false;
    familyMembers = [];
    renderTaskAssigneePicker("Impossible de charger les membres. Vérifiez les droits Supabase puis actualisez.");
    showToast("Chargement des membres impossible");
    taskFamilyId = null;
  } finally { taskLoading = false; }
}

function renderTasks() {
  const list = document.getElementById("taskList");
  if (!list) return;
  list.replaceChildren();
  familyTasks.forEach(task => {
    const row = document.createElement("article");
    row.className = `task-row${task.status === "done" ? " task-done" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-checkbox";
    check.checked = task.status === "done";
    check.setAttribute("aria-label", check.checked ? `Remettre « ${task.title} » à faire` : `Marquer « ${task.title} » comme terminée`);
    check.addEventListener("change", async () => {
      check.disabled = true;
      const bridge = getFamilyBridge();
      const done = check.checked;
      const { error } = await bridge.client.from("tasks").update({
        status: done ? "done" : "todo",
        completed_by: done ? bridge.getCurrentUser()?.id || null : null,
        completed_at: done ? new Date().toISOString() : null
      }).eq("id", task.id);
      if (error) { check.checked = !done; showToast("Modification impossible"); console.error(error); }
      else { await loadFamilyTasks(); showToast(done ? "Tâche terminée" : "Tâche remise à faire"); }
      check.disabled = false;
    });
    const info = document.createElement("div"); info.className = "task-info";
    const title = document.createElement("strong"); title.textContent = task.title;
    const names = task.assigneeIds.map(id => familyMembers.find(member => member.user_id === id)?.display_name).filter(Boolean);
    const meta = document.createElement("span");
    meta.textContent = names.length ? `Attribuée à : ${names.join(", ")}` : "Tâche familiale — tout le monde";
    info.append(title, meta);
    row.append(check, info, makeDeleteButton(task.title, async () => {
      if (!confirm(`Supprimer la tâche « ${task.title} » ?`)) return;
      const { error } = await getFamilyBridge().client.from("tasks").delete().eq("id", task.id);
      if (error) { showToast("Suppression impossible"); console.error(error); return; }
      await loadFamilyTasks(); showToast("Tâche supprimée");
    }));
    list.append(row);
  });
  document.getElementById("tasksEmpty").classList.toggle("hidden", familyTasks.length > 0);
  document.getElementById("tasksSummaryCount").textContent = familyTasks.filter(task => task.status !== "done").length;
}

document.getElementById("taskForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("taskInput");
  const title = input.value.trim();
  if (!title) return;
  const bridge = getFamilyBridge();
  if (!bridge || !taskFamilyId) { showToast("Le foyer familial n'est pas encore prêt"); return; }
  const button = document.querySelector("#taskForm button[type=submit]");
  button.disabled = true;
  try {
    const selected = [...document.querySelectorAll('input[name="taskAssignee"]:checked')].map(el => el.value);
    const user = bridge.getCurrentUser();
    const { data: task, error } = await bridge.client.from("tasks").insert({
      family_id: taskFamilyId,
      title,
      assignment_type: selected.length === 1 ? "individual" : "family",
      assigned_to: selected.length === 1 ? selected[0] : null,
      created_by: user?.id
    }).select("id").single();
    if (error) throw error;
    if (selected.length) {
      const rows = selected.map(userId => ({ task_id: task.id, family_id: taskFamilyId, user_id: userId }));
      const { error: assignError } = await bridge.client.from("task_assignees").insert(rows);
      if (assignError) {
        await bridge.client.from("tasks").delete().eq("id", task.id);
        throw assignError;
      }
    }
    input.value = "";
    document.querySelectorAll('input[name="taskAssignee"]').forEach(el => { el.checked = false; });
    await loadFamilyTasks();
    showToast("Tâche ajoutée et synchronisée");
  } catch (error) {
    console.error("Création de tâche impossible:", error);
    showToast(error.message || "Impossible d'ajouter la tâche");
  } finally { button.disabled = false; }
});

window.addEventListener("family-app-family-ready", event => {
  initializeShoppingSync(event.detail?.familyId);
  initializeTaskSync(event.detail?.familyId);
  initializeMealSync(event.detail?.familyId);
});

// Planning des repas partagé via Supabase.
let mealFamilyId = null;
let mealEntries = [];
let mealMembers = [];
let mealChannel = null;
let mealPoll = null;
let mealWeekOffset = 0;
let mealLoading = false;

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function startOfMealWeek(offset = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday + offset * 7);
  return date;
}
function formatMealWeek(date) {
  const end = new Date(date); end.setDate(end.getDate() + 6);
  const fmt = value => value.toLocaleDateString("fr-CH", { day: "numeric", month: "short" });
  return `${fmt(date)} – ${fmt(end)} ${end.getFullYear()}`;
}
function escapeMealText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
async function loadMealEntries() {
  const bridge = getFamilyBridge();
  if (!bridge || !mealFamilyId) return;
  const start = startOfMealWeek(mealWeekOffset);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const { data, error } = await bridge.client.from("meal_entries")
    .select("id, family_id, meal_date, meal_type, title, notes, is_planned, created_by, updated_at")
    .eq("family_id", mealFamilyId)
    .gte("meal_date", dateKey(start)).lte("meal_date", dateKey(end))
    .order("meal_date", { ascending: true });
  if (error) throw error;
  mealEntries = data || [];
  const ids = mealEntries.map(item => item.id);
  let attendance = [];
  if (ids.length) {
    const result = await bridge.client.from("meal_attendance")
      .select("meal_entry_id, user_id, is_present")
      .in("meal_entry_id", ids);
    if (result.error) throw result.error;
    attendance = result.data || [];
  }
  mealEntries = mealEntries.map(item => ({
    ...item,
    absentIds: attendance.filter(row => row.meal_entry_id === item.id && row.is_present === false).map(row => row.user_id)
  }));
  renderMealWeek();
}
function renderMealWeek() {
  const target = document.getElementById("mealWeekGrid");
  if (!target) return;
  const weekStart = startOfMealWeek(mealWeekOffset);
  const todayKey = dateKey(new Date());
  const label = document.getElementById("mealWeekLabel");
  if (label) label.textContent = mealWeekOffset === 0 ? `Cette semaine · ${formatMealWeek(weekStart)}` : formatMealWeek(weekStart);
  target.replaceChildren();
  const weekdays = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
  for (let i = 0; i < 7; i++) {
    const date = new Date(weekStart); date.setDate(date.getDate() + i);
    const key = dateKey(date);
    const day = document.createElement("article");
    day.className = `meal-day${key === todayKey ? " today" : ""}`;
    const heading = document.createElement("div"); heading.className = "meal-day-heading";
    const title = document.createElement("strong"); title.textContent = `${weekdays[i]} ${date.toLocaleDateString("fr-CH", { day: "numeric", month: "short" })}`;
    const tag = document.createElement("span"); tag.textContent = key === todayKey ? "AUJOURD’HUI" : (i >= 5 ? "WEEK-END" : "");
    heading.append(title, tag); day.append(heading);
    ["lunch", "dinner"].forEach(type => {
      const entry = mealEntries.find(item => item.meal_date === key && item.meal_type === type);
      const slot = document.createElement("div"); slot.className = "meal-slot";
      const icon = document.createElement("span"); icon.className = "slot-icon"; icon.textContent = type === "lunch" ? "☀️" : "🌙";
      const content = document.createElement("div"); content.className = "meal-slot-content";
      const small = document.createElement("small"); small.textContent = type === "lunch" ? "MIDI" : "SOIR";
      const mealTitle = document.createElement("strong");
      mealTitle.textContent = !entry ? "À définir" : (entry.is_planned === false ? "Aucun repas prévu" : entry.title);
      content.append(small, mealTitle);
      const actions = document.createElement("div"); actions.className = "meal-slot-actions";
      const action = (text, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = `meal-action ${cls || ""}`; b.textContent = text; b.addEventListener("click", fn); return b; };
      if (!entry) {
        actions.append(action("＋ Repas", "", () => editMeal(null, key, type)), action("Non prévu", "", () => setMealNotPlanned(null, key, type)));
      } else {
        actions.append(action(entry.is_planned === false ? "＋ Prévoir" : "Modifier", "", () => editMeal(entry, key, type)));
        actions.append(action("×", "danger", () => deleteMeal(entry)));
      }
      slot.append(icon, content, actions);
      if (entry && entry.is_planned !== false) {
        const presence = document.createElement("div"); presence.className = "meal-presence";
        const caption = document.createElement("span"); caption.className = "meal-presence-label"; caption.textContent = "Absences (touchez un membre pour le signaler)"; presence.append(caption);
        mealMembers.forEach(member => {
          const absent = entry.absentIds.includes(member.user_id);
          const person = document.createElement("button"); person.type = "button";
          person.className = `meal-person${absent ? " absent" : ""}`;
          person.setAttribute("aria-pressed", absent ? "true" : "false");
          const dot = document.createElement("span"); dot.className = "presence-dot";
          const name = document.createElement("span"); name.textContent = `${member.display_name}${absent ? " · absent" : ""}`;
          person.append(dot, name);
          person.addEventListener("click", () => toggleMealAbsence(entry, member.user_id, !absent));
          presence.append(person);
        });
        slot.append(presence);
      }
      day.append(slot);
    });
    target.append(day);
  }
}
async function editMeal(entry, mealDate, mealType) {
  const current = entry && entry.is_planned !== false ? entry.title : "";
  const title = prompt(entry ? "Modifier le repas prévu :" : "Quel repas est prévu ?", current);
  if (title === null) return;
  const clean = title.trim();
  if (!clean) { showToast("Indique un repas ou annule la modification"); return; }
  const bridge = getFamilyBridge();
  const payload = { family_id: mealFamilyId, meal_date: mealDate, meal_type: mealType, title: clean, is_planned: true, created_by: bridge.getCurrentUser()?.id };
  let query;
  if (entry) query = bridge.client.from("meal_entries").update({ title: clean, is_planned: true }).eq("id", entry.id);
  else query = bridge.client.from("meal_entries").insert(payload);
  const { error } = await query;
  if (error) { console.error(error); showToast("Enregistrement du repas impossible"); return; }
  await loadMealEntries(); showToast("Planning des repas actualisé");
}
async function setMealNotPlanned(entry, mealDate, mealType) {
  if (!confirm("Indiquer qu’aucun repas n’est prévu à ce moment ?")) return;
  const bridge = getFamilyBridge();
  let error;
  if (entry) {
    const result = await bridge.client.from("meal_attendance").delete().eq("meal_entry_id", entry.id);
    if (result.error) { showToast("Impossible de mettre à jour les présences"); return; }
    const updated = await bridge.client.from("meal_entries").update({ title: "Aucun repas prévu", is_planned: false }).eq("id", entry.id);
    error = updated.error;
  } else {
    const result = await bridge.client.from("meal_entries").insert({ family_id: mealFamilyId, meal_date: mealDate, meal_type: mealType, title: "Aucun repas prévu", is_planned: false, created_by: bridge.getCurrentUser()?.id });
    error = result.error;
  }
  if (error) { console.error(error); showToast("Modification impossible"); return; }
  await loadMealEntries(); showToast("Repas marqué comme non prévu");
}
async function deleteMeal(entry) {
  if (!confirm("Supprimer ce repas du planning ?")) return;
  const { error } = await getFamilyBridge().client.from("meal_entries").delete().eq("id", entry.id);
  if (error) { console.error(error); showToast("Suppression impossible"); return; }
  await loadMealEntries(); showToast("Repas supprimé du planning");
}
async function toggleMealAbsence(entry, userId, absent) {
  const bridge = getFamilyBridge();
  const buttonUser = userId;
  let result;
  if (absent) {
    result = await bridge.client.from("meal_attendance").upsert({ meal_entry_id: entry.id, family_id: mealFamilyId, user_id: buttonUser, is_present: false }, { onConflict: "meal_entry_id,user_id" });
  } else {
    result = await bridge.client.from("meal_attendance").delete().eq("meal_entry_id", entry.id).eq("user_id", buttonUser);
  }
  if (result.error) { console.error(result.error); showToast("Modification de présence impossible"); return; }
  await loadMealEntries();
  const member = mealMembers.find(item => item.user_id === userId);
  showToast(`${member?.display_name || "Membre"} : ${absent ? "absent" : "présent"}`);
}
async function initializeMealSync(familyId) {
  const bridge = getFamilyBridge();
  if (!bridge || !familyId || mealLoading) return;
  if (mealFamilyId === familyId) { try { await loadMealEntries(); } catch (error) { console.error(error); showToast("Actualisation des repas impossible"); } return; }
  mealLoading = true;
  try {
    if (mealChannel) { await bridge.client.removeChannel(mealChannel); mealChannel = null; }
    if (mealPoll) { clearInterval(mealPoll); mealPoll = null; }
    mealFamilyId = familyId;
    const { data: membersData, error: membersError } = await bridge.client.from("family_members")
      .select("user_id, display_name").eq("family_id", familyId).order("joined_at", { ascending: true });
    if (membersError) throw membersError;
    mealMembers = membersData || [];
    await loadMealEntries();
    mealChannel = bridge.client.channel(`family-meals-${familyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "meal_entries", filter: `family_id=eq.${familyId}` }, () => loadMealEntries().catch(error => console.warn("Realtime repas:", error)))
      .on("postgres_changes", { event: "*", schema: "public", table: "meal_attendance", filter: `family_id=eq.${familyId}` }, () => loadMealEntries().catch(error => console.warn("Realtime présences:", error)))
      .subscribe();
    mealPoll = setInterval(() => loadMealEntries().catch(error => console.warn("Actualisation repas:", error)), 15000);
  } catch (error) {
    console.error("Initialisation des repas impossible:", error);
    mealFamilyId = null;
    const target = document.getElementById("mealWeekGrid");
    if (target) target.innerHTML = '<div class="empty-state"><div>⚠️</div><strong>Planning indisponible</strong><p>Vérifiez que la mise à jour SQL Repas a bien été exécutée.</p></div>';
    showToast("Impossible de charger le planning des repas");
  } finally { mealLoading = false; }
}
document.getElementById("mealPrevWeek").addEventListener("click", () => { mealWeekOffset--; loadMealEntries().catch(error => { console.error(error); showToast("Chargement de la semaine impossible"); }); });
document.getElementById("mealNextWeek").addEventListener("click", () => { mealWeekOffset++; loadMealEntries().catch(error => { console.error(error); showToast("Chargement de la semaine impossible"); }); });

document.getElementById("addEvent").addEventListener("click", () => showToast("La création d'événements sera ajoutée dans le module Calendrier."));
function renderCalendar() {
  const target = document.getElementById("calendarDays"); const year = 2026, month = 10;
  const firstDay = new Date(year, month, 1); const offset = (firstDay.getDay() + 6) % 7; const count = new Date(year, month + 1, 0).getDate(); target.innerHTML = "";
  for (let i=0; i<offset; i++) { const b = document.createElement("button"); b.className = "muted-day"; b.textContent = new Date(year, month, 0).getDate() - offset + i + 1; b.disabled = true; target.append(b); }
  for (let day=1; day<=count; day++) { const b = document.createElement("button"); b.textContent = day; if (day === 20) b.className = "today"; b.addEventListener("click", () => showToast(`Sélection du ${day} novembre (aperçu)`)); target.append(b); }
}
renderCalendar(); renderShopping(); renderTasks();
renderTaskAssigneePicker("Connectez-vous pour charger les membres du foyer.");
renderMealWeek();
const today = new Date(); document.getElementById("todayLabel").textContent = today.toLocaleDateString("fr-CH",{weekday:"long",day:"numeric",month:"long"}).toUpperCase();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", async () => { try { const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }); await registration.update(); }
    catch (error) { console.warn("Family-app : mise à jour du service worker impossible", error); }
  });
}
