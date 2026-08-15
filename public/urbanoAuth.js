// URBANO Gaming — Application Shell authentication seam.
//
// No canonical URBANO identity provider is connected yet. A Foreign
// Evidence Intake is currently determining which implementation owns
// canonical URBANO member identity, and whether identity will
// eventually be shared via Supabase Auth, cross-app SSO, OAuth/OIDC,
// shared session cookies, or another mechanism entirely. This module
// exists so every page in this shell calls one seam instead of each
// page guessing an answer — when a real provider is chosen, only this
// file should need to change.
//
// This module must never report an authenticated state, and must never
// create an account, token, or session of any kind. It intentionally
// has no dependency on @supabase/supabase-js or any other provider SDK.

const UrbanoAuth = {
  /**
   * Always "unauthenticated" today. No provider is connected. Callers
   * should treat this as the only truthful state until a real identity
   * integration replaces this module.
   */
  getState() {
    return { status: "unauthenticated" };
  },

  isAuthenticated() {
    return this.getState().status === "authenticated";
  },

  /**
   * There is nothing to sign in to yet. This intentionally does not
   * open a login form, does not redirect anywhere, and does not
   * fabricate a signed-in state. Callers should present the resolved
   * "not_connected" status honestly (see attachSignInButton below).
   */
  async signIn() {
    return { status: "not_connected" };
  },

  async signOut() {
    return { status: "unauthenticated" };
  },

  /**
   * Wires a "Sign in with URBANO" button to this seam and an adjacent
   * honest-status element, so every page using this seam behaves
   * identically without duplicating the same handler.
   */
  attachSignInButton(buttonEl, statusEl) {
    if (!buttonEl) return;
    buttonEl.addEventListener("click", async () => {
      const result = await this.signIn();
      if (statusEl && result.status === "not_connected") {
        statusEl.textContent =
          "URBANO sign-in isn't connected here yet — you can still browse Gaming. This will use your existing URBANO membership once identity is connected.";
        statusEl.style.display = "block";
      }
    });
  },
};
