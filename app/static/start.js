const tabs = document.querySelectorAll(".auth-tab");
const signinForm = document.getElementById("signin-form");
const signupForm = document.getElementById("signup-form");

tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");

        const isSignup = tab.dataset.tab === "signup";
        signinForm.classList.toggle("hidden-form", isSignup);
        signupForm.classList.toggle("hidden-form", !isSignup);
    });
});
