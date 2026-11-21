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

function renderTaskAssigneePicker() {
  const target = document.getElementById("taskAssignees");
  if (!target) return;
  target.replaceChildren();
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
    showToast("Tâches non synchronisées : vérifiez Supabase");
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
});

document.getElementById("addEvent").addEventListener("click", () => showToast("La création d'événements sera ajoutée dans le module Calendrier."));
document.querySelectorAll(".meal-slot button").forEach(el => el.addEventListener("click", () => showToast("L'édition des repas sera ajoutée dans le module Repas.")));
function renderCalendar() {
  const target = document.getElementById("calendarDays"); const year = 2026, month = 10;
  const firstDay = new Date(year, month, 1); const offset = (firstDay.getDay() + 6) % 7; const count = new Date(year, month + 1, 0).getDate(); target.innerHTML = "";
  for (let i=0; i<offset; i++) { const b = document.createElement("button"); b.className = "muted-day"; b.textContent = new Date(year, month, 0).getDate() - offset + i + 1; b.disabled = true; target.append(b); }
  for (let day=1; day<=count; day++) { const b = document.createElement("button"); b.textContent = day; if (day === 20) b.className = "today"; b.addEventListener("click", () => showToast(`Sélection du ${day} novembre (aperçu)`)); target.append(b); }
}
renderCalendar(); renderShopping(); renderTasks();
const today = new Date(); document.getElementById("todayLabel").textContent = today.toLocaleDateString("fr-CH",{weekday:"long",day:"numeric",month:"long"}).toUpperCase();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", async () => { try { const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }); await registration.update(); }
    catch (error) { console.warn("Family-app : mise à jour du service worker impossible", error); }
  });
}
