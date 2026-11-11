
// =====================================
// RECODDLY APPLICATION
// Human-like AI + PostgreSQL
// =====================================

let currentChat = null;
let isGenerating = false;

// =====================================
// THEME
// =====================================

function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("recoddlyTheme", theme);
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme || "dark";
    setTheme(current === "dark" ? "light" : "dark");
}

setTheme(localStorage.getItem("recoddlyTheme") || "dark");

// =====================================
// MOBILE SIDEBAR
// =====================================

function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");

    if (sidebar) sidebar.classList.toggle("open");
}

function closeSidebar() {
    const sidebar = document.getElementById("sidebar");

    if (sidebar) sidebar.classList.remove("open");
}

// =====================================
// API HELPER
// =====================================

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.details || data.error || "Something went wrong.");
    }

    return data;
}

// =====================================
// MARKDOWN RENDERER
// =====================================

function renderMarkdown(text) {
    if (
        typeof marked === "undefined" ||
        typeof DOMPurify === "undefined"
    ) {
        const fallback = document.createElement("div");
        fallback.textContent = text;
        return fallback.innerHTML;
    }

    const html = marked.parse(text, {
        breaks: true,
        gfm: true
    });

    return DOMPurify.sanitize(html);
}

// =====================================
// NAVIGATION
// =====================================

function showPage(page, button) {
    const selectedPage = document.getElementById(page);

    if (!selectedPage) return;

    document.querySelectorAll(".page").forEach(section => {
        section.classList.remove("active");
    });

    selectedPage.classList.add("active");

    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.remove("active");
    });

    if (!button) {
        button = Array.from(
            document.querySelectorAll(".nav-item")
        ).find(item =>
            item.getAttribute("onclick")?.includes(`'${page}'`)
        );
    }

    if (button) button.classList.add("active");

    const titles = {
        chat: "New chat",
        recent: "Recent chats",
        tasks: "Tasks",
        devices: "Connected Devices",
        settings: "Settings",
        profile: "Profile"
    };

    const pageTitle = document.getElementById("pageTitle");

    if (pageTitle) {
        pageTitle.textContent = titles[page] || "Recoddly";
    }

    localStorage.setItem("recoddlyLastPage", page);

    if (page === "recent") displayRecentChats();
    if (page === "tasks") displayTasks();
    if (page === "devices") updateDeviceCount();

    closeSidebar();
}

// =====================================
// NEW CHAT
// =====================================

function newChat() {
    if (isGenerating) return;

    currentChat = null;

    document.getElementById("chatMessages").innerHTML = "";
    document.getElementById("chatInput").value = "";
    document.getElementById("welcome").style.display = "block";

    showPage("chat");
}

// =====================================
// DISPLAY MESSAGES
// =====================================

function addMessage(text, type) {
    const container = document.getElementById("chatMessages");
    const message = document.createElement("div");

    message.className = "message " + type;

    if (type === "bot") {
        message.innerHTML = renderMarkdown(text);
    } else {
        message.textContent = text;
    }

    container.appendChild(message);
    container.scrollTop = container.scrollHeight;

    return message;
}

// =====================================
// SEND MESSAGE
// =====================================

async function sendMessage() {
    if (isGenerating) return;

    const input = document.getElementById("chatInput");
    const idea = input.value.trim();

    if (!idea) return;

    if (idea.length > 5000) {
        alert("Please keep your message under 5000 characters.");
        return;
    }

    isGenerating = true;

    document.getElementById("welcome").style.display = "none";

    addMessage(idea, "user");
    input.value = "";

    const loadingMessage = addMessage(
        "Recoddly is thinking... ✨",
        "bot"
    );

    try {
        const data = await api("/api/generate-plan", {
            method: "POST",
            body: JSON.stringify({
                idea: idea,
                chat_id: currentChat ? currentChat.id : null
            })
        });

        if (!data.success || !data.reply || !data.chat) {
            throw new Error("The AI returned an incomplete response.");
        }

        loadingMessage.innerHTML = renderMarkdown(data.reply);
        currentChat = data.chat;

        if (data.mode === "plan") {
            const taskNote = document.createElement("p");

            taskNote.className = "task-success-note";
            taskNote.textContent =
                `✓ ${data.tasks_created} tasks saved to your workspace`;

            loadingMessage.appendChild(taskNote);
        }

    } catch (error) {
        console.error("Recoddly error:", error);

        loadingMessage.textContent =
            "Sorry! I couldn't process your message. " + error.message;

    } finally {
        isGenerating = false;
        input.focus();
    }
}

// =====================================
// SUGGESTIONS
// =====================================

function suggest(text) {
    document.getElementById("chatInput").value = text;
    document.getElementById("chatInput").focus();
}

// =====================================
// APPLE STYLE DELETE MODAL
// =====================================

function showDeleteModal() {
    return new Promise(resolve => {

        const existingModal = document.getElementById("deleteModal");

        if (existingModal) existingModal.remove();

        const overlay = document.createElement("div");
        overlay.id = "deleteModal";
        overlay.className = "delete-modal-overlay";

        overlay.innerHTML = `
            <div class="delete-modal" role="dialog"
                 aria-modal="true"
                 aria-labelledby="deleteModalTitle">

                <div class="delete-modal-icon">
                    <span>⌫</span>
                </div>

                <h2 id="deleteModalTitle">Delete this chat?</h2>

                <p>
                    This conversation and all tasks created
                    from it will be permanently deleted.
                </p>

                <div class="delete-modal-actions">
                    <button class="delete-cancel-btn" type="button">
                        Cancel
                    </button>

                    <button class="delete-confirm-btn" type="button">
                        Delete Chat
                    </button>
                </div>

            </div>
        `;

        document.body.appendChild(overlay);

        const cancelButton = overlay.querySelector(".delete-cancel-btn");
        const confirmButton = overlay.querySelector(".delete-confirm-btn");

        let finished = false;

        function closeModal(result) {
            if (finished) return;

            finished = true;

            document.removeEventListener("keydown", handleEscape);

            overlay.classList.remove("visible");

            setTimeout(() => {
                overlay.remove();
            }, 250);

            resolve(result);
        }

        function handleEscape(event) {
            if (event.key === "Escape") {
                closeModal(false);
            }
        }

        cancelButton.addEventListener("click", () => {
            closeModal(false);
        });

        confirmButton.addEventListener("click", () => {
            closeModal(true);
        });

        overlay.addEventListener("click", event => {
            if (event.target === overlay) {
                closeModal(false);
            }
        });

        document.addEventListener("keydown", handleEscape);

        requestAnimationFrame(() => {
            overlay.classList.add("visible");
            cancelButton.focus();
        });
    });
}

// =====================================
// RECENT CHATS
// =====================================

async function displayRecentChats() {
    const container = document.getElementById("recentChats");

    if (!container) return;

    container.innerHTML = "Loading your conversations...";

    try {
        const data = await api("/api/chats");
        const chats = data.chats || [];

        container.innerHTML = "";

        if (chats.length === 0) {
            container.textContent = "No chats yet. Start your first idea!";
            return;
        }

        chats.forEach(chat => {
            const card = document.createElement("div");
            card.className = "content-card chat-card";

            const chatInfo = document.createElement("div");
            chatInfo.className = "chat-card-info";

            const title = document.createElement("strong");
            title.textContent = "✳ " + chat.title;

            const date = document.createElement("p");
            date.textContent = chat.updated_at
                ? new Date(chat.updated_at).toLocaleString()
                : "";

            chatInfo.append(title, date);

            chatInfo.addEventListener("click", () => {
                openChat(chat.id);
            });

            const deleteButton = document.createElement("button");
            deleteButton.className = "chat-delete-btn";
            deleteButton.textContent = "Delete";
            deleteButton.type = "button";

            deleteButton.addEventListener("click", event => {
                event.stopPropagation();
                deleteChat(chat.id);
            });

            card.append(chatInfo, deleteButton);
            container.appendChild(card);
        });

    } catch (error) {
        container.textContent = "Couldn't load chats: " + error.message;
    }
}

// =====================================
// DELETE CHAT AND RELATED TASKS
// =====================================

async function deleteChat(chatId) {
    if (isGenerating) return;

    const confirmed = await showDeleteModal();

    if (!confirmed) return;

    try {
        await api("/api/chats/" + chatId, {
            method: "DELETE"
        });

        if (
            currentChat &&
            String(currentChat.id) === String(chatId)
        ) {
            currentChat = null;

            document.getElementById("chatMessages").innerHTML = "";
            document.getElementById("chatInput").value = "";
            document.getElementById("welcome").style.display = "block";
        }

        await displayRecentChats();
        await displayTasks();

        // Small success notification
        showToast("Chat deleted successfully");

    } catch (error) {
        showToast("Couldn't delete chat: " + error.message);
    }
}

// =====================================
// SUCCESS / ERROR TOAST
// =====================================

function showToast(message) {
    const oldToast = document.getElementById("recoddlyToast");

    if (oldToast) oldToast.remove();

    const toast = document.createElement("div");
    toast.id = "recoddlyToast";
    toast.className = "recoddly-toast";
    toast.textContent = message;

    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {
        toast.classList.remove("show");

        setTimeout(() => toast.remove(), 300);
    }, 2600);
}

// =====================================
// OPEN OLD CHAT
// =====================================

async function openChat(id) {
    if (isGenerating) return;

    try {
        const data = await api("/api/chats/" + id);

        currentChat = data.chat;

        document.getElementById("chatMessages").innerHTML = "";
        document.getElementById("welcome").style.display = "none";

        (currentChat.messages || []).forEach(message => {
            addMessage(message.text, message.type);
        });

        showPage("chat");

    } catch (error) {
        alert("Couldn't open chat: " + error.message);
    }
}

// =====================================
// TASKS
// =====================================

async function displayTasks() {
    const container = document.getElementById("taskList");

    if (!container) return;

    container.innerHTML = "Loading your tasks...";

    try {
        const data = await api("/api/tasks");
        const tasks = data.tasks || [];

        container.innerHTML = "";

        if (tasks.length === 0) {
            container.textContent =
                "No tasks yet. Ask Recoddly to create an execution plan!";
            return;
        }

        tasks.forEach(task => {
            const card = document.createElement("div");
            card.className = "content-card";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = task.completed;
            checkbox.style.width = "auto";
            checkbox.style.marginRight = "12px";

            const title = document.createElement("span");
            title.textContent = task.title;

            if (task.completed) {
                title.style.textDecoration = "line-through";
                title.style.opacity = "0.5";
            }

            checkbox.onchange = async () => {
                checkbox.disabled = true;

                try {
                    await api("/api/tasks/" + task.id, {
                        method: "PATCH",
                        body: JSON.stringify({
                            completed: checkbox.checked
                        })
                    });

                    displayTasks();

                } catch (error) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.disabled = false;

                    alert("Couldn't update task: " + error.message);
                }
            };

            card.append(checkbox, title);
            container.appendChild(card);
        });

    } catch (error) {
        container.textContent = "Couldn't load tasks: " + error.message;
    }
}

// =====================================
// VOICE INPUT
// =====================================

function startVoice() {
    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        alert("Voice recognition is not supported in this browser.");
        return;
    }

    const recognition = new SpeechRecognition();

    recognition.lang = "en-IN";
    recognition.interimResults = false;

    recognition.onresult = event => {
        document.getElementById("chatInput").value =
            event.results[0][0].transcript;
    };

    recognition.onerror = () => {
        alert("Microphone error. Check browser permissions.");
    };

    recognition.start();
}

// =====================================
// OLD BROWSER DATA MIGRATION
// =====================================

async function migrateOldBrowserData() {
    if (localStorage.getItem("recoddlyMigratedToPostgres") === "yes") {
        return;
    }

    let oldChats = [];
    let oldTasks = [];

    try {
        oldChats = JSON.parse(
            localStorage.getItem("recoddlyChats") || "[]"
        );

        oldTasks = JSON.parse(
            localStorage.getItem("recoddlyTasks") || "[]"
        );

    } catch (error) {
        console.error("Old browser data could not be read:", error);
        return;
    }

    if (!oldChats.length && !oldTasks.length) {
        localStorage.setItem("recoddlyMigratedToPostgres", "yes");
        return;
    }

    try {
        await api("/api/migrate-local-data", {
            method: "POST",
            body: JSON.stringify({
                chats: oldChats,
                tasks: oldTasks
            })
        });

        localStorage.removeItem("recoddlyChats");
        localStorage.removeItem("recoddlyTasks");

        localStorage.setItem("recoddlyMigratedToPostgres", "yes");

    } catch (error) {
        console.error("Migration failed:", error);
    }
}

// =====================================
// CONNECTED DEVICES
// =====================================

const deviceNames = {
    watch: "Smartwatch",
    glasses: "Smart Glasses",
    earbuds: "AI Earbuds"
};

function getDeviceStatus() {
    try {
        return JSON.parse(
            localStorage.getItem("recoddlyDevices") || "{}"
        );
    } catch {
        return {};
    }
}

function saveDeviceStatus(devices) {
    localStorage.setItem(
        "recoddlyDevices",
        JSON.stringify(devices)
    );
}

function updateDeviceCount() {
    const devices = getDeviceStatus();

    const count = Object.values(devices)
        .filter(status => status === true).length;

    const counter = document.getElementById("connectedCount");

    if (counter) counter.textContent = count;

    Object.keys(deviceNames).forEach(id => {
        const connected = devices[id] === true;

        const status = document.getElementById(id + "Status");
        const button = document.getElementById(id + "Button");

        if (!status || !button) return;

        status.textContent = connected
            ? "● Connected"
            : "● Disconnected";

        status.classList.toggle("connected", connected);

        button.textContent = connected
            ? "Disconnect device"
            : "Connect device";
    });
}

function toggleDevice(id) {
    if (!deviceNames[id]) return;

    const devices = getDeviceStatus();

    devices[id] = devices[id] !== true;

    saveDeviceStatus(devices);
    updateDeviceCount();
}

function sendDeviceCommand() {
    const selected = document.getElementById("deviceSelect").value;

    const command = document.getElementById("deviceCommand")
        .value.trim();

    const response = document.getElementById("deviceResponse");

    const devices = getDeviceStatus();

    response.style.display = "block";

    if (!devices[selected]) {
        response.textContent =
            "⚠ Please connect " + deviceNames[selected] +
            " before sending a command.";
        return;
    }

    if (!command) {
        response.textContent = "Please enter a command first.";
        return;
    }

    response.textContent =
        "✓ Command successfully simulated through " +
        deviceNames[selected] + ". Your command: \"" +
        command + "\". Recoddly has received this demonstration command.";

    document.getElementById("deviceCommand").value = "";
}

// =====================================
// DEVICE VOICE COMMAND
// =====================================

function startDeviceVoice() {
    const selected = document.getElementById("deviceSelect").value;
    const devices = getDeviceStatus();

    if (!devices[selected]) {
        alert("Please connect " + deviceNames[selected] + " first.");
        return;
    }

    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        alert("Voice recognition is not supported in this browser.");
        return;
    }

    const recognition = new SpeechRecognition();

    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
        const response = document.getElementById("deviceResponse");

        response.style.display = "block";
        response.textContent =
            "🎙 Listening through simulated " + deviceNames[selected] + "...";
    };

    recognition.onresult = event => {
        const command = event.results[0][0].transcript;

        document.getElementById("deviceCommand").value = command;
        document.getElementById("chatInput").value = command;

        showPage("chat");
        sendMessage();
    };

    recognition.onerror = event => {
        alert("Voice recognition error: " + event.error);
    };

    recognition.start();
}

// =====================================
// PAGE LOAD
// =====================================

document.addEventListener("DOMContentLoaded", async () => {
    const input = document.getElementById("chatInput");

    if (input) {
        input.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    await migrateOldBrowserData();

    const lastPage = localStorage.getItem("recoddlyLastPage") || "chat";

    if (document.getElementById(lastPage)) {
        showPage(lastPage);
    } else {
        showPage("chat");
    }

    updateDeviceCount();
});