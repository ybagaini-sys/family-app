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

function renderTasks() {
  const list = document.getElementById("taskList"); list.replaceChildren();
  localData.tasks.forEach(task => {
    const row = document.createElement("article"); row.className = `task-row${task.done ? " task-done" : ""}`;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-checkbox";
    check.checked = !!task.done;
    check.setAttribute("aria-label", task.done ? `Remettre « ${task.name} » à faire` : `Marquer « ${task.name} » comme terminée`);
    check.title = task.done ? "Décocher pour remettre cette tâche à faire" : "Cocher lorsque cette tâche est terminée";
    check.addEventListener("change", () => {
      // Une tâche terminée peut toujours être décochée pour revenir à « à faire ».
      task.done = check.checked;
      saveLocalData();
      renderTasks();
      showToast(task.done ? "Tâche terminée" : "Tâche remise à faire");
    });
    const info = document.createElement("div"); info.className = "task-info";
    const title = document.createElement("strong"); title.textContent = task.name;
    const meta = document.createElement("span"); meta.textContent = `Ajoutée par ${task.author}`;
    info.append(title, meta);
    row.append(check, info, makeDeleteButton(task.name, () => {
      localData.tasks = localData.tasks.filter(entry => entry.id !== task.id); saveLocalData(); renderTasks(); showToast("Tâche supprimée");
    }));
    list.append(row);
  });
  document.getElementById("tasksEmpty").classList.toggle("hidden", localData.tasks.length > 0);
  document.getElementById("tasksSummaryCount").textContent = localData.tasks.filter(task => !task.done).length;
}
document.getElementById("taskForm").addEventListener("submit", event => {
  event.preventDefault(); const input = document.getElementById("taskInput"); const value = input.value.trim(); if (!value) return;
  localData.tasks.push({id: `${Date.now()}-${Math.random()}`, name:value, author:currentMember, done:false}); saveLocalData(); renderTasks(); input.value = ""; showToast("Tâche ajoutée");
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
