// Le membre actif est déterminé exclusivement par le compte Supabase connecté.
const views = ["home","shopping","meals","calendar","tasks"];
const STORAGE_KEY = "family-app-local-v1";
let localData = { shopping: [], tasks: [] };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  if (saved && Array.isArray(saved.shopping) && Array.isArray(saved.tasks)) localData = saved;
} catch (error) { console.warn("Données locales illisibles", error); }

// Les courses, les tâches et les repas sont partagés via Supabase.
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
  // La consultation d’une rubrique marque ses nouveautés comme lues pour ce membre uniquement.
  if (view !== "home") markFamilyNotificationsRead(view);
  window.scrollTo({top:0, behavior:"smooth"});
}
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.go)));
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

// Nouveautés centralisées : chaque membre dispose de son propre état de lecture.
const unreadTypeByView = { shopping: "shopping_item", meals: "meal_entry", calendar: "calendar_event", tasks: "task" };
let familyNotificationChannel = null;
let familyNotificationPoll = null;
let familyNotificationFamilyId = null;
let familyNotificationRefreshBusy = false;

async function refreshFamilyUnreadCounts() {
  const bridge = getFamilyBridge();
  const userId = bridge?.getCurrentUser?.()?.id;
  if (!bridge?.client || !userId) return;
  if (familyNotificationRefreshBusy) return;
  familyNotificationRefreshBusy = true;
  try {
    const { data, error } = await bridge.client.from("family_notifications")
      .select("entity_type, entity_id").eq("recipient_user_id", userId).is("read_at", null);
    if (error) throw error;
    const unreadEntities = { shopping: new Set(), meals: new Set(), calendar: new Set(), tasks: new Set() };
    (data || []).forEach(row => {
      const key = ({ shopping_item: "shopping", meal_entry: "meals", calendar_event: "calendar", task: "tasks" })[row.entity_type];
      if (key) unreadEntities[key].add(String(row.entity_id));
    });
    const counts = Object.fromEntries(Object.entries(unreadEntities).map(([key, ids]) => [key, ids.size]));
    Object.entries(counts).forEach(([key, count]) => {
      document.querySelectorAll(`[data-unread-badge="${key}"]`).forEach(badge => {
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.classList.toggle("hidden", count === 0);
      });
    });
  } catch (error) {
    console.warn("Compteurs de nouveautés indisponibles :", error);
  } finally { familyNotificationRefreshBusy = false; }
}

async function markFamilyNotificationsRead(view) {
  const type = unreadTypeByView[view];
  const bridge = getFamilyBridge();
  const userId = bridge?.getCurrentUser?.()?.id;
  if (!type || !bridge?.client || !userId) return;
  try {
    const { error } = await bridge.client.from("family_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_user_id", userId).eq("entity_type", type).is("read_at", null);
    if (error) throw error;
    await refreshFamilyUnreadCounts();
  } catch (error) { console.warn("Lecture des nouveautés impossible :", error); }
}

async function recordFamilyChange(familyId, entityType, entityId, action, title, message) {
  const bridge = getFamilyBridge();
  const user = bridge?.getCurrentUser?.();
  if (!bridge?.client || !familyId || !user?.id) return;
  try {
    const { data: members, error: membersError } = await bridge.client.from("family_members")
      .select("user_id").eq("family_id", familyId);
    if (membersError) throw membersError;
    const rows = (members || []).filter(member => member.user_id !== user.id).map(member => ({
      family_id: familyId, actor_user_id: user.id, recipient_user_id: member.user_id,
      entity_type: entityType, entity_id: String(entityId), action, title, message: message || null
    }));
    if (!rows.length) return;
    const { error } = await bridge.client.from("family_notifications").insert(rows);
    if (error) throw error;
    await refreshFamilyUnreadCounts();
  } catch (error) { console.warn("Enregistrement de la nouveauté impossible :", error); }
}

async function initializeFamilyNotifications(familyId) {
  const bridge = getFamilyBridge();
  if (!bridge?.client || !familyId) return;
  if (familyNotificationFamilyId === familyId) { await refreshFamilyUnreadCounts(); return; }
  familyNotificationFamilyId = familyId;
  if (familyNotificationChannel) await bridge.client.removeChannel(familyNotificationChannel);
  if (familyNotificationPoll) clearInterval(familyNotificationPoll);
  familyNotificationChannel = bridge.client.channel(`family-notifications-${familyId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "family_notifications", filter: `family_id=eq.${familyId}` }, refreshFamilyUnreadCounts)
    .subscribe();
  familyNotificationPoll = setInterval(refreshFamilyUnreadCounts, 15000);
  await refreshFamilyUnreadCounts();
}

// Envoi des notifications familiales. L'échec push ne doit jamais annuler
// une opération déjà enregistrée dans Supabase.
async function notifyFamily(title, body, url = null) {
  // URL canonique GitHub Pages : l'application vit sous /family-app/, jamais à la racine.
  const appBaseUrl = "https://ybagaini-sys.github.io/family-app/";
  let notificationUrl = new URL(url || "?view=tasks", appBaseUrl);
  if (notificationUrl.origin === "https://ybagaini-sys.github.io" &&
      !notificationUrl.pathname.startsWith("/family-app/")) {
    notificationUrl = new URL("/family-app/" + notificationUrl.pathname.replace(/^\/+/, ""), "https://ybagaini-sys.github.io");
  }
  notificationUrl = notificationUrl.href;
  const bridge = getFamilyBridge();
  if (!bridge?.client || !bridge.getCurrentUser?.()) return;
  try {
    const { data, error } = await bridge.client.functions.invoke(
      "send-family-notification",
      { body: { title, body, url: notificationUrl } }
    );
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    console.info("Notification familiale traitée:", data);
    return data;
  } catch (error) {
    console.warn("Notification non envoyée (l'action reste enregistrée):", error);
    return null;
  }
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
      await recordFamilyChange(shoppingFamilyId, "shopping_item", item.id, "updated", "Article modifié", `${item.name} : ${checkbox.checked ? "acheté" : "à acheter"}`);
      await notifyFamily("Liste de courses modifiée", `${item.name} : ${checkbox.checked ? "acheté" : "à acheter"}`, "?view=shopping");
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
      await recordFamilyChange(shoppingFamilyId, "shopping_item", item.id, "deleted", "Article supprimé", item.name);
      await notifyFamily("Article supprimé", item.name, "?view=shopping");
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
  const { data: addedItem, error } = await bridge.client.from("shopping_items").insert({
    list_id: shoppingListId, name: value, is_completed: false, added_by: bridge.getCurrentUser()?.id
  }).select("id").single();
  button.disabled = false;
  if (error) { console.error(error); showToast("Ajout impossible : vérifiez la connexion"); return; }
  input.value = "";
  if (addedItem?.id) await recordFamilyChange(shoppingFamilyId, "shopping_item", addedItem.id, "created", "Nouvel article", value);
  await notifyFamily("Nouvel article dans les courses", value, "?view=shopping");
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
      else {
        await recordFamilyChange(taskFamilyId, "task", task.id, "updated", done ? "Tâche terminée" : "Tâche remise à faire", task.title);
        await notifyFamily(
          done ? "Tâche terminée" : "Tâche remise à faire",
          `« ${task.title} » a été ${done ? "terminée" : "remise à faire"}.`
        );
        await loadFamilyTasks();
        showToast(done ? "Tâche terminée" : "Tâche remise à faire");
      }
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
      await recordFamilyChange(taskFamilyId, "task", task.id, "deleted", "Tâche supprimée", task.title);
      await notifyFamily("Tâche supprimée", `La tâche « ${task.title} » a été supprimée.`);
      await loadFamilyTasks(); showToast("Tâche supprimée");
    }));
    list.append(row);
  });
  document.getElementById("tasksEmpty").classList.toggle("hidden", familyTasks.length > 0);
  document.getElementById("tasksSummaryCount").textContent = familyTasks.length;
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
    await recordFamilyChange(taskFamilyId, "task", task.id, "created", "Nouvelle tâche", title);
    const assigneeNames = selected
      .map(userId => familyMembers.find(member => member.user_id === userId)?.display_name)
      .filter(Boolean);
    await notifyFamily(
      "1 nouvelle tâche",
      assigneeNames.length
        ? `« ${title} » attribuée à ${assigneeNames.join(", ")}.`
        : `« ${title} » a été ajoutée au foyer.`
    );
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
  initializeCalendarSync(event.detail?.familyId);
  initializeFamilyNotifications(event.detail?.familyId);
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (views.includes(requestedView)) navigate(requestedView);
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
  const mealId = entry?.id || (await bridge.client.from("meal_entries").select("id").eq("family_id", mealFamilyId).eq("meal_date", mealDate).eq("meal_type", mealType).maybeSingle()).data?.id;
  if (mealId) await recordFamilyChange(mealFamilyId, "meal_entry", mealId, entry ? "updated" : "created", entry ? "Repas modifié" : "Nouveau repas", clean);
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
  const mealId = entry?.id || (await bridge.client.from("meal_entries").select("id").eq("family_id", mealFamilyId).eq("meal_date", mealDate).eq("meal_type", mealType).maybeSingle()).data?.id;
  if (mealId) await recordFamilyChange(mealFamilyId, "meal_entry", mealId, "updated", "Planning repas modifié", "Aucun repas prévu");
  await notifyFamily("Planning repas modifié", "Aucun repas prévu", "?view=meals");
  await loadMealEntries(); showToast("Repas marqué comme non prévu");
}
async function deleteMeal(entry) {
  if (!confirm("Supprimer ce repas du planning ?")) return;
  const { error } = await getFamilyBridge().client.from("meal_entries").delete().eq("id", entry.id);
  if (error) { console.error(error); showToast("Suppression impossible"); return; }
  await recordFamilyChange(mealFamilyId, "meal_entry", entry.id, "deleted", "Repas supprimé", entry.title);
  await notifyFamily("Repas supprimé", entry.title, "?view=meals");
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
  const member = mealMembers.find(item => item.user_id === userId);
  await recordFamilyChange(mealFamilyId, "meal_entry", entry.id, "updated", "Présence au repas modifiée", `${member?.display_name || "Un membre"} : ${absent ? "absent" : "présent"}`);
  await notifyFamily("Présence au repas modifiée", `${member?.display_name || "Un membre"} : ${absent ? "absent" : "présent"}`, "?view=meals");
  await loadMealEntries();
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


// Notifications Web Push — inscription de l'appareil courant.
const FAMILY_VAPID_PUBLIC_KEY = "BDR_ixuFwYFq5I1FOPomJ6KKfoKhVRKMZYcMDqJiviEgbEo_EEb7CtHcZgTXCpQeduazOyBAYoXzOHEVPKsZbkw";

function pushBase64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
function setPushStatus(text) {
  const target = document.getElementById("pushStatus");
  if (target) target.textContent = text;
}
async function updatePushButtonState() {
  const button = document.getElementById("enablePushButton");
  if (!button) return;
  const bridge = getFamilyBridge();
  if (!bridge?.getCurrentUser?.()) {
    button.disabled = true;
    setPushStatus("Connectez-vous pour activer les notifications.");
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    button.disabled = true;
    setPushStatus("Les notifications push ne sont pas prises en charge par ce navigateur.");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      button.textContent = "Activées";
      button.disabled = true;
      setPushStatus("Cet appareil est inscrit aux notifications familiales.");
    } else if (Notification.permission === "denied") {
      button.textContent = "Bloquées";
      button.disabled = true;
      setPushStatus("Les notifications sont bloquées dans les réglages de cet appareil.");
    } else {
      button.textContent = "Activer";
      button.disabled = false;
      setPushStatus("Activez les notifications sur cet appareil pour recevoir les nouvelles du foyer.");
    }
  } catch (error) {
    console.warn("Vérification push impossible:", error);
    button.disabled = false;
  }
}
async function enableFamilyPush() {
  const button = document.getElementById("enablePushButton");
  const bridge = getFamilyBridge();
  if (!bridge?.getCurrentUser?.()) { showToast("Connectez-vous d'abord"); return; }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    showToast("Notifications non prises en charge sur cet appareil"); return;
  }
  if (!window.matchMedia("(display-mode: standalone)").matches && !window.navigator.standalone) {
    showToast("Ajoutez d'abord Family-app à l'écran d'accueil, puis ouvrez son icône"); return;
  }
  if (button) { button.disabled = true; button.textContent = "Activation…"; }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Autorisation de notification non accordée.");
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushBase64UrlToBytes(FAMILY_VAPID_PUBLIC_KEY)
      });
    }
    const json = subscription.toJSON();
    const user = bridge.getCurrentUser();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Abonnement incomplet fourni par le navigateur.");
    const record = {
      user_id: user.id,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth_key: json.keys.auth,
      device_label: `${navigator.platform || "Appareil"} · ${/iPad|iPhone|iPod/.test(navigator.userAgent) ? "Apple" : "Web"}`
    };
    const { data: existing, error: findError } = await bridge.client
      .from("push_subscriptions").select("id").eq("endpoint", record.endpoint).maybeSingle();
    if (findError) throw findError;
    const result = existing
      ? await bridge.client.from("push_subscriptions").update(record).eq("id", existing.id)
      : await bridge.client.from("push_subscriptions").insert(record);
    if (result.error) throw result.error;
    showToast("Notifications activées sur cet appareil");
    setPushStatus("Notifications activées sur cet appareil.");
    if (button) { button.textContent = "Activées"; button.disabled = true; }
  } catch (error) {
    console.error("Activation des notifications impossible:", error);
    showToast(error?.message || "Activation des notifications impossible");
    setPushStatus(error?.message || "Activation impossible. Vérifiez les réglages de notifications.");
    if (button) { button.textContent = "Réessayer"; button.disabled = false; }
  }
}
const enablePushButton = document.getElementById("enablePushButton");
if (enablePushButton) enablePushButton.addEventListener("click", enableFamilyPush);
window.addEventListener("family-app-family-ready", () => updatePushButtonState());
window.addEventListener("load", () => updatePushButtonState());

// Agenda familial connecté à Supabase : les événements génèrent des nouveautés individuelles.
let calendarFamilyId = null;
let calendarEvents = [];
let calendarChannel = null;
let calendarPoll = null;
let calendarLoading = false;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = null;

function calendarDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function eventDateKey(event) {
  const date = new Date(event.starts_at);
  return calendarDateKey(date);
}

function renderCalendarEvents() {
  const target = document.getElementById("calendarEventsList");
  if (!target) return;
  target.replaceChildren();
  const upcoming = selectedCalendarDate
    ? calendarEvents.filter(event => eventDateKey(event) === selectedCalendarDate)
    : calendarEvents.filter(event => new Date(event.starts_at).getTime() >= Date.now() - 86400000);
  const heading = document.getElementById("calendarEventsHeading");
  if (heading) heading.textContent = selectedCalendarDate
    ? `Événements du ${new Date(`${selectedCalendarDate}T12:00:00`).toLocaleDateString("fr-CH", { day:"numeric", month:"long", year:"numeric" })}`
    : "Prochains événements";
  if (!upcoming.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = selectedCalendarDate
      ? '<div>🗓️</div><strong>Aucun rendez-vous ce jour</strong><p>Sélectionnez un autre jour ou ajoutez un événement.</p>'
      : '<div>🗓️</div><strong>Aucun événement à venir</strong><p>Ajoutez les activités et rendez-vous de la famille.</p>';
    target.append(empty);
    return;
  }
  upcoming.forEach(event => {
    const card = document.createElement("article");
    card.className = "calendar-event-card";
    const date = document.createElement("strong");
    date.textContent = new Date(event.starts_at).toLocaleString("fr-CH", { weekday:"short", day:"numeric", month:"short", hour: event.is_all_day ? undefined : "2-digit", minute: event.is_all_day ? undefined : "2-digit" });
    const title = document.createElement("div"); title.className = "calendar-event-title"; title.textContent = event.title;
    card.append(date, title);
    if (event.description) { const desc = document.createElement("p"); desc.textContent = event.description; card.append(desc); }
    const actions = document.createElement("div"); actions.className = "calendar-event-actions";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "text-button"; edit.textContent = "Modifier";
    edit.addEventListener("click", async () => {
      const values = await showEventEditor(event);
      if (!values) return;
      const { error } = await getFamilyBridge().client.from("calendar_events").update({ title: values.title, starts_at: values.startsAt.toISOString() }).eq("id", event.id);
      if (error) { console.error(error); showToast("Modification impossible"); return; }
      await recordFamilyChange(calendarFamilyId, "calendar_event", event.id, "updated", "Rendez-vous modifié", values.title);
      await notifyFamily("Rendez-vous modifié", values.title, "?view=calendar");
      await loadCalendarEvents();
    });
    const del = makeDeleteButton(event.title, async () => {
      if (!confirm(`Supprimer le rendez-vous « ${event.title} » ?`)) return;
      const { error } = await getFamilyBridge().client.from("calendar_events").delete().eq("id", event.id);
      if (error) { console.error(error); showToast("Suppression impossible"); return; }
      await recordFamilyChange(calendarFamilyId, "calendar_event", event.id, "deleted", "Rendez-vous supprimé", event.title);
      await notifyFamily("Rendez-vous supprimé", event.title, "?view=calendar");
      await loadCalendarEvents();
    });
    actions.append(edit, del); card.append(actions); target.append(card);
  });
}

async function loadCalendarEvents() {
  const bridge = getFamilyBridge();
  if (!bridge?.client || !calendarFamilyId) return;
  const { data, error } = await bridge.client.from("calendar_events")
    .select("id, family_id, title, description, starts_at, ends_at, is_all_day, created_by")
    .eq("family_id", calendarFamilyId).order("starts_at", { ascending: true });
  if (error) throw error;
  calendarEvents = data || [];
  renderCalendar();
  renderCalendarEvents();
}

async function initializeCalendarSync(familyId) {
  const bridge = getFamilyBridge();
  if (!bridge?.client || !familyId || calendarLoading) return;
  if (calendarFamilyId === familyId) { try { await loadCalendarEvents(); } catch (error) { console.warn("Agenda:", error); } return; }
  calendarLoading = true;
  try {
    if (calendarChannel) await bridge.client.removeChannel(calendarChannel);
    if (calendarPoll) clearInterval(calendarPoll);
    calendarFamilyId = familyId;
    await loadCalendarEvents();
    calendarChannel = bridge.client.channel(`family-calendar-${familyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "calendar_events", filter: `family_id=eq.${familyId}` }, () => loadCalendarEvents().catch(error => console.warn("Realtime agenda:", error)))
      .subscribe();
    calendarPoll = setInterval(() => loadCalendarEvents().catch(error => console.warn("Actualisation agenda:", error)), 15000);
  } catch (error) {
    console.error("Initialisation agenda impossible:", error);
    calendarFamilyId = null;
    showToast("Agenda non synchronisé : vérifiez la connexion");
  } finally { calendarLoading = false; }
}

// Éditeur de rendez-vous : calendrier natif pour le jour et choix par quart d'heure.
const eventEditorBackdrop = document.getElementById("eventEditorBackdrop");
const eventEditorForm = document.getElementById("eventEditorForm");
const eventTitleInput = document.getElementById("eventTitleInput");
const eventDateInput = document.getElementById("eventDateInput");
const eventHourInput = document.getElementById("eventHourInput");
const eventMinuteInput = document.getElementById("eventMinuteInput");
const eventEditorTitle = document.getElementById("eventEditorTitle");
let eventEditorResolve = null;

for (let hour = 0; hour < 24; hour++) {
  const option = document.createElement("option");
  option.value = String(hour).padStart(2, "0");
  option.textContent = option.value;
  eventHourInput.append(option);
}
function localDateInputValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function showEventEditor(event = null) {
  const initial = event ? new Date(event.starts_at) : new Date(Date.now() + 3600000);
  if (!event) initial.setMinutes(Math.ceil(initial.getMinutes()/15)*15, 0, 0);
  eventEditorTitle.textContent = event ? "Modifier le rendez-vous" : "Nouveau rendez-vous";
  eventTitleInput.value = event?.title || "";
  eventDateInput.value = localDateInputValue(initial);
  eventHourInput.value = String(initial.getHours()).padStart(2, "0");
  eventMinuteInput.value = String(Math.floor(initial.getMinutes()/15)*15).padStart(2, "0");
  eventEditorBackdrop.classList.remove("hidden");
  setTimeout(() => eventTitleInput.focus(), 80);
  return new Promise(resolve => { eventEditorResolve = resolve; });
}
function closeEventEditor(result = null) {
  eventEditorBackdrop.classList.add("hidden");
  if (eventEditorResolve) eventEditorResolve(result);
  eventEditorResolve = null;
}
document.getElementById("eventEditorCancel").addEventListener("click", () => closeEventEditor());
eventEditorBackdrop.addEventListener("click", event => { if (event.target === eventEditorBackdrop) closeEventEditor(); });
eventEditorForm.addEventListener("submit", event => {
  event.preventDefault();
  const title = eventTitleInput.value.trim();
  if (!title) { showToast("Le titre du rendez-vous est nécessaire"); eventTitleInput.focus(); return; }
  if (!eventDateInput.value) { showToast("Choisissez une date"); return; }
  const [year, month, day] = eventDateInput.value.split("-").map(Number);
  const startsAt = new Date(year, month - 1, day, Number(eventHourInput.value), Number(eventMinuteInput.value), 0, 0);
  if (Number.isNaN(startsAt.getTime())) { showToast("Date ou heure invalide"); return; }
  closeEventEditor({ title, startsAt });
});

document.getElementById("addEvent").addEventListener("click", async () => {
  if (!calendarFamilyId) { showToast("L'agenda familial n'est pas encore prêt"); return; }
  const values = await showEventEditor();
  if (!values) return;
  const { data, error } = await getFamilyBridge().client.from("calendar_events").insert({ family_id: calendarFamilyId, title: values.title, starts_at: values.startsAt.toISOString(), created_by: getFamilyBridge().getCurrentUser()?.id }).select("id").single();
  if (error) { console.error(error); showToast("Création du rendez-vous impossible"); return; }
  await recordFamilyChange(calendarFamilyId, "calendar_event", data.id, "created", "Nouveau rendez-vous", values.title);
  await notifyFamily("Nouveau rendez-vous", values.title, "?view=calendar");
  await loadCalendarEvents(); showToast("Rendez-vous ajouté au calendrier");
});

function renderCalendar() {
  const target = document.getElementById("calendarDays");
  if (!target) return;
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const offset = (firstDay.getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const todayKey = calendarDateKey(new Date());
  document.getElementById("monthName").textContent = calendarMonth.toLocaleDateString("fr-CH", { month:"long", year:"numeric" });
  target.replaceChildren();
  for (let i = 0; i < offset; i++) {
    const b = document.createElement("button");
    b.className = "muted-day";
    b.textContent = new Date(year, month, 0).getDate() - offset + i + 1;
    b.disabled = true;
    target.append(b);
  }
  for (let day = 1; day <= count; day++) {
    const date = new Date(year, month, day);
    const key = calendarDateKey(date);
    const hasEvents = calendarEvents.some(event => eventDateKey(event) === key);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "calendar-day";
    if (key === todayKey) b.classList.add("today");
    if (key === selectedCalendarDate) b.classList.add("selected-day");
    if (hasEvents) b.classList.add("has-events");
    b.setAttribute("aria-label", `${date.toLocaleDateString("fr-CH", { day:"numeric", month:"long" })}${hasEvents ? ", rendez-vous prévu" : ""}`);
    b.setAttribute("aria-pressed", key === selectedCalendarDate ? "true" : "false");
    const number = document.createElement("span");
    number.className = "calendar-day-number";
    number.textContent = String(day);
    b.append(number);
    if (hasEvents) {
      const marker = document.createElement("span");
      marker.className = "calendar-day-marker";
      marker.setAttribute("aria-hidden", "true");
      b.append(marker);
    }
    b.addEventListener("click", () => {
      selectedCalendarDate = key;
      renderCalendar();
      renderCalendarEvents();
    });
    target.append(b);
  }
}

const calendarMonthButtons = document.querySelectorAll(".calendar-month button");
calendarMonthButtons[0]?.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  selectedCalendarDate = null;
  renderCalendar();
  renderCalendarEvents();
});
calendarMonthButtons[1]?.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  selectedCalendarDate = null;
  renderCalendar();
  renderCalendarEvents();
});

renderCalendar(); renderShopping(); renderTasks();
renderTaskAssigneePicker("Connectez-vous pour charger les membres du foyer.");
renderMealWeek();
const today = new Date(); document.getElementById("todayLabel").textContent = today.toLocaleDateString("fr-CH",{weekday:"long",day:"numeric",month:"long"}).toUpperCase();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", async () => { try { const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }); await registration.update(); }
    catch (error) { console.warn("Family-app : mise à jour du service worker impossible", error); }
  });
}
