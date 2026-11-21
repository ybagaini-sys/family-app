import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import "./app-core.js";

// Configuration publique du projet Supabase.
// La clé publishable est prévue pour être utilisée dans le navigateur.
// La sécurité des données repose sur l'authentification et les politiques RLS.
const SUPABASE_URL = "https://zptlqachtxlxyakhiznx.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7__vXqA3NBE5MlWMAr9_7Q_ItkW--rp";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

const $ = (id) => document.getElementById(id);
const authScreen = $("authScreen");
const appShell = $("appShell");
const authForms = $("authForms");
const familySetup = $("familySetup");
const authMessage = $("authMessage");
const familyMessage = $("familyMessage");

let currentUser = null;
let currentFamilyId = null;
let authMode = "login";

// Pont sécurisé côté interface : app-core.js utilise le client authentifié
// et l'identifiant du foyer courant, sans exposer de clé secrète.
window.familyAppSupabase = {
  client: supabase,
  getCurrentFamilyId: () => currentFamilyId,
  getCurrentUser: () => currentUser
};

function message(target, text, isError = false) {
  target.textContent = text;
  target.classList.toggle("error", isError);
}

function setAuthMode(mode) {
  authMode = mode;
  $("loginForm").classList.toggle("hidden", mode !== "login");
  $("signupForm").classList.toggle("hidden", mode !== "signup");
  $("showLogin").classList.toggle("active", mode === "login");
  $("showSignup").classList.toggle("active", mode === "signup");
  $("authTitle").textContent = mode === "login" ? "Bienvenue" : "Créer votre compte";
  $("authIntro").textContent = mode === "login"
    ? "Connectez-vous pour retrouver votre famille."
    : "Un compte personnel pour chaque membre du foyer.";
  message(authMessage, "");
}

function setFamilyMode(mode) {
  $("createFamilyForm").classList.toggle("hidden", mode !== "create");
  $("joinFamilyForm").classList.toggle("hidden", mode !== "join");
  $("createFamilyTab").classList.toggle("active", mode === "create");
  $("joinFamilyTab").classList.toggle("active", mode === "join");
  message(familyMessage, "");
}

function showAuthentication() {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  authForms.classList.remove("hidden");
  familySetup.classList.add("hidden");
  const inviteCode = getInvitationCodeFromUrl();
  if (inviteCode) {
    $("authIntro").textContent = "Vous avez reçu une invitation familiale. Connectez-vous ou créez votre compte pour rejoindre le foyer.";
  }
}

function getInvitationCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("invite") || "").trim();
}

function applyInvitationLink() {
  const inviteCode = getInvitationCodeFromUrl();
  if (!inviteCode) return;
  const field = $("inviteCode");
  if (field) field.value = inviteCode;
  setFamilyMode("join");
  message(familyMessage, "Lien d’invitation détecté. Vous pouvez rejoindre ce foyer.");
}

function showFamilySetup() {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  authForms.classList.add("hidden");
  familySetup.classList.remove("hidden");
  applyInvitationLink();
}

function showApplication() {
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
}

async function loadFamily() {
  const { data, error } = await supabase
    .from("family_members")
    .select("family_id, display_name, families(name, invite_code)")
    .eq("user_id", currentUser.id)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  currentFamilyId = data.family_id;
  const displayName = data.display_name || currentUser.user_metadata?.display_name || "Membre";
  const welcomeName = $("welcomeName");
  if (welcomeName) welcomeName.textContent = displayName;

  const avatar = $("profileButton");
  if (avatar) avatar.textContent = displayName.trim().charAt(0).toUpperCase();
  const inviteCode = data.families?.invite_code || "";
  const inviteNode = $("familyInviteCode");
  if (inviteNode) inviteNode.textContent = inviteCode || "Indisponible";
  return data;
}

async function refreshApplicationState() {
  if (!currentUser) {
    currentFamilyId = null;
    showAuthentication();
    return;
  }

  try {
    const family = await loadFamily();
    if (!family) {
      showFamilySetup();
      return;
    }
    showApplication();
    window.dispatchEvent(new CustomEvent("family-app-family-ready", {
      detail: { familyId: currentFamilyId }
    }));
  } catch (error) {
    console.error("Chargement du foyer impossible:", error);
    showFamilySetup();
    message(familyMessage, "Impossible de charger votre foyer. Vérifiez la connexion puis réessayez.", true);
  }
}

$("showLogin").addEventListener("click", () => setAuthMode("login"));
$("showSignup").addEventListener("click", () => setAuthMode("signup"));
$("createFamilyTab").addEventListener("click", () => setFamilyMode("create"));
$("joinFamilyTab").addEventListener("click", () => setFamilyMode("join"));

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("loginForm").querySelector("button[type=submit]");
  button.disabled = true;
  message(authMessage, "Connexion en cours…");
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: $("loginEmail").value.trim(),
      password: $("loginPassword").value
    });
    if (error) throw error;
    message(authMessage, "Connexion réussie.");
  } catch (error) {
    message(authMessage, error.message || "Connexion impossible.", true);
  } finally {
    button.disabled = false;
  }
});

$("signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("signupForm").querySelector("button[type=submit]");
  button.disabled = true;
  message(authMessage, "Création du compte…");
  const name = $("signupName").value.trim();
  try {
    const { data, error } = await supabase.auth.signUp({
      email: $("signupEmail").value.trim(),
      password: $("signupPassword").value,
      options: {
        data: { display_name: name, full_name: name },
        emailRedirectTo: window.location.href
      }
    });
    if (error) throw error;

    if (data.session) {
      message(authMessage, "Compte créé. Préparation de votre espace familial…");
    } else {
      message(authMessage, "Compte créé. Consultez votre boîte e-mail et confirmez votre adresse avant de vous connecter.");
      setAuthMode("login");
    }
  } catch (error) {
    message(authMessage, error.message || "Création du compte impossible.", true);
  } finally {
    button.disabled = false;
  }
});

$("createFamilyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("createFamilyForm").querySelector("button[type=submit]");
  button.disabled = true;
  message(familyMessage, "Création de votre foyer…");
  try {
    const name = $("familyName").value.trim();
    const displayName = currentUser.user_metadata?.display_name
      || currentUser.user_metadata?.full_name
      || currentUser.email.split("@")[0];
    const { data, error } = await supabase.rpc("create_family", {
      p_name: name,
      p_display_name: displayName
    });
    if (error) throw error;

    // Création de la première liste commune de courses.
    const { error: listError } = await supabase.from("shopping_lists").insert({
      family_id: data,
      name: "Courses"
    });
    if (listError) throw listError;

    currentFamilyId = data;
    await refreshApplicationState();
  } catch (error) {
    message(familyMessage, error.message || "Création du foyer impossible.", true);
  } finally {
    button.disabled = false;
  }
});

$("joinFamilyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("joinFamilyForm").querySelector("button[type=submit]");
  button.disabled = true;
  message(familyMessage, "Connexion au foyer…");
  try {
    const displayName = currentUser.user_metadata?.display_name
      || currentUser.user_metadata?.full_name
      || currentUser.email.split("@")[0];
    const { error } = await supabase.rpc("join_family", {
      p_invite_code: $("inviteCode").value.trim(),
      p_display_name: displayName
    });
    if (error) throw error;
    await refreshApplicationState();
  } catch (error) {
    message(familyMessage, error.message || "Impossible de rejoindre ce foyer.", true);
  } finally {
    button.disabled = false;
  }
});

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error(error);
    return;
  }
  currentUser = null;
  currentFamilyId = null;
  showAuthentication();
}

$("signOutButton").addEventListener("click", signOut);
$("setupSignOut").addEventListener("click", signOut);
$("copyInviteCode").addEventListener("click", async () => {
  const code = $("familyInviteCode").textContent.trim();
  if (!code || code === "Chargement…" || code === "Indisponible") return;
  const invitationUrl = new URL(window.location.href);
  invitationUrl.searchParams.set("invite", code);
  invitationUrl.hash = "";
  try {
    await navigator.clipboard.writeText(invitationUrl.toString());
    const button = $("copyInviteCode");
    button.textContent = "Lien copié !";
    setTimeout(() => { button.textContent = "Copier le lien"; }, 1800);
  } catch {
    message(authMessage, "Copie impossible sur cet appareil. Vous pouvez copier le lien depuis la barre d’adresse.", true);
  }
});

// Au démarrage, restaure la session éventuellement déjà présente.
const { data: sessionData } = await supabase.auth.getSession();
currentUser = sessionData.session?.user || null;
await refreshApplicationState();

supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user || null;
  // Evite de bloquer le callback Supabase par des requêtes synchrones.
  setTimeout(() => refreshApplicationState(), 0);
});

