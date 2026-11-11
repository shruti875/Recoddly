
import os
import json
import re
from functools import wraps

import psycopg
from psycopg.rows import dict_row
from psycopg.errors import UniqueViolation

from flask import (
    Flask, render_template, request, redirect,
    url_for, session, flash, jsonify
)

from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "change-this-secret")

DATABASE_URL = os.getenv("DATABASE_URL")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


# =====================================
# DATABASE
# =====================================

def get_db():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is missing.")

    return psycopg.connect(
        DATABASE_URL,
        row_factory=dict_row
    )


def initialize_database():

    with get_db() as db:

        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS chats (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS chats_user_idx
            ON chats(user_id, updated_at DESC)
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,
                chat_id BIGINT,
                title TEXT NOT NULL,
                completed BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Delete related tasks automatically when a chat is deleted.

        db.execute("""
            ALTER TABLE tasks
            DROP CONSTRAINT IF EXISTS tasks_chat_id_fkey
        """)

        db.execute("""
            ALTER TABLE tasks
            ADD CONSTRAINT tasks_chat_id_fkey
            FOREIGN KEY (chat_id)
            REFERENCES chats(id)
            ON DELETE CASCADE
        """)

        db.execute("""
            CREATE INDEX IF NOT EXISTS tasks_user_idx
            ON tasks(user_id, created_at DESC)
        """)


# =====================================
# LOGIN SECURITY
# =====================================

def login_required(function):

    @wraps(function)
    def wrapper(*args, **kwargs):

        if "user_id" not in session:

            if request.path.startswith("/api/"):
                return jsonify({
                    "error": "Please log in again."
                }), 401

            return redirect(url_for("login"))

        return function(*args, **kwargs)

    return wrapper


# =====================================
# HOME
# =====================================

@app.route("/")
def home():

    if "user_id" in session:
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


@app.route("/health")
def health():

    try:
        with get_db() as db:
            db.execute("SELECT 1")

        return jsonify({
            "success": True,
            "database": "PostgreSQL connected"
        })

    except Exception:
        app.logger.exception("Health check failed")

        return jsonify({
            "success": False,
            "error": "Database connection failed"
        }), 503


# =====================================
# SIGNUP
# =====================================

@app.route("/signup", methods=["GET", "POST"])
def signup():

    if request.method == "POST":

        name = request.form.get("name", "").strip()
        username = request.form.get("username", "").strip().lower()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")

        if not all([name, username, email, password]):
            flash("Please complete all fields.")
            return redirect(url_for("signup"))

        if len(password) < 8:
            flash("Password must have at least 8 characters.")
            return redirect(url_for("signup"))

        try:
            with get_db() as db:

                user = db.execute("""
                    INSERT INTO users
                    (name, username, email, password)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                """, (
                    name,
                    username,
                    email,
                    generate_password_hash(password)
                )).fetchone()

            session.clear()
            session["user_id"] = user["id"]

            return redirect(url_for("dashboard"))

        except UniqueViolation:
            flash("Username or email already exists.")

        except Exception:
            app.logger.exception("Signup failed")
            flash("Signup failed. Check PostgreSQL.")

    return render_template("login.html", mode="signup")


# =====================================
# LOGIN
# =====================================

@app.route("/login", methods=["GET", "POST"])
def login():

    if request.method == "POST":

        identity = request.form.get("identity", "").strip().lower()
        password = request.form.get("password", "")

        try:
            with get_db() as db:

                user = db.execute("""
                    SELECT id, password
                    FROM users
                    WHERE username = %s OR email = %s
                """, (identity, identity)).fetchone()

            if user and check_password_hash(user["password"], password):

                session.clear()
                session["user_id"] = user["id"]

                return redirect(url_for("dashboard"))

            flash("Incorrect username/email or password.")

        except Exception:
            app.logger.exception("Login failed")
            flash("Login failed. Check PostgreSQL.")

    return render_template("login.html", mode="login")


# =====================================
# DASHBOARD
# =====================================

@app.route("/dashboard")
@login_required
def dashboard():

    with get_db() as db:

        user = db.execute("""
            SELECT id, name, username, email
            FROM users
            WHERE id = %s
        """, (session["user_id"],)).fetchone()

    if not user:
        session.clear()
        return redirect(url_for("login"))

    return render_template("dashboard.html", user=user)


# =====================================
# LOGOUT
# =====================================

@app.route("/logout")
def logout():

    session.clear()
    return redirect(url_for("login"))


# =====================================
# IMPROVED AI RESPONSE PARSER
# =====================================

def parse_ai_response(raw):

    if not raw or not raw.strip():
        raise ValueError("AI returned an empty response.")

    raw = raw.strip()

    # Remove Markdown JSON code fences if present.
    raw = re.sub(r"^\s*```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```\s*$", "", raw)

    decoder = json.JSONDecoder()
    result = None

    # Find and decode the first complete JSON object.
    # Any extra text after that object will be ignored.
    for match in re.finditer(r"\{", raw):

        try:
            candidate, end_position = decoder.raw_decode(
                raw[match.start():]
            )

            if isinstance(candidate, dict):
                result = candidate
                break

        except json.JSONDecodeError:
            continue

    if not isinstance(result, dict):
        raise ValueError(
            "Could not find a valid JSON object in the AI response."
        )

    mode = result.get("mode", "chat")

    if mode not in ("chat", "plan"):
        mode = "chat"

    reply = str(result.get("reply", "")).strip()

    tasks = result.get("tasks", [])

    if not isinstance(tasks, list):
        tasks = []

    tasks = [
        str(task).strip()[:500]
        for task in tasks
        if isinstance(task, str) and task.strip()
    ][:30]

    return mode, reply, tasks


# =====================================
# HUMAN-LIKE AI CHAT + PLANNING
# =====================================

@app.route("/api/generate-plan", methods=["POST"])
@login_required
def generate_plan():

    if not client:
        return jsonify({
            "error": "Groq API key is missing in .env"
        }), 500

    data = request.get_json(silent=True) or {}

    idea = str(data.get("idea", "")).strip()
    chat_id = data.get("chat_id")

    if not idea:
        return jsonify({
            "error": "Please enter a message."
        }), 400

    if len(idea) > 5000:
        return jsonify({
            "error": "Message must be under 5000 characters."
        }), 400

    try:

        with get_db() as db:

            if chat_id:

                chat = db.execute("""
                    SELECT id, title, messages
                    FROM chats
                    WHERE id = %s AND user_id = %s
                """, (
                    chat_id,
                    session["user_id"]
                )).fetchone()

                if not chat:
                    return jsonify({
                        "error": "Chat not found."
                    }), 404

                old_messages = chat["messages"] or []

            else:
                chat = None
                old_messages = []

        history = []

        for message in old_messages[-16:]:

            role = (
                "assistant"
                if message.get("type") == "bot"
                else "user"
            )

            history.append({
                "role": role,
                "content": str(message.get("text", ""))[:5000]
            })

        system_prompt = """
You are Recoddly, a friendly and intelligent personal AI assistant.

PERSONALITY:
- Talk naturally, like a helpful human assistant.
- Be warm, clear, friendly and conversational.
- Understand the previous conversation.
- Remember the context of the current chat.
- Answer normal questions directly.
- Avoid robotic or unnecessarily formal language.
- Use Markdown for headings, bold text and bullet points.
- Keep answers concise unless detail is useful.

TWO MODES:

MODE 1: CHAT

Use chat mode for:
- Greetings and casual conversations.
- Questions and explanations.
- Follow-up questions.
- General advice.
- Any request that does not need an execution plan.

In chat mode:
- Answer the user's actual question.
- Do not generate a project plan unnecessarily.
- Return an empty tasks array.

MODE 2: PLAN

Use plan mode when the user wants to:
- Organize an idea.
- Start a project or business.
- Plan studies or an event.
- Break a goal into actionable steps.
- Create a schedule or execution roadmap.
- Turn an instruction into manageable tasks.

In plan mode:
- Give a useful, realistic execution plan.
- Use clear Markdown headings.
- Include numbered actionable steps.
- Give a reasonable timeline when useful.
- Return the individual actionable tasks in the tasks array.
- Make tasks short and practical.

IMPORTANT:
If the user says something like "What do you think about my idea?",
answer conversationally unless they explicitly request a plan.

If the user asks a follow-up about an existing plan,
use the previous conversation to understand it.

Return ONLY one valid JSON object in this exact structure:

{
  "mode": "chat",
  "reply": "Your Markdown formatted response",
  "tasks": []
}

For a plan, use:

{
  "mode": "plan",
  "reply": "Your complete Markdown formatted execution plan",
  "tasks": [
    "First actionable task",
    "Second actionable task"
  ]
}

Do not put JSON inside Markdown code fences.
Do not return multiple JSON objects.
Do not add any text before or after the JSON object.
"""

        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": system_prompt
                },
                *history,
                {
                    "role": "user",
                    "content": idea
                }
            ],
            temperature=0.6,
            max_completion_tokens=3000,
            response_format={"type": "json_object"}
        )

        raw = response.choices[0].message.content or ""

        app.logger.info("Received AI response for Recoddly.")

        mode, reply, tasks = parse_ai_response(raw)

        if not reply:
            raise ValueError("AI returned an empty response.")

        new_messages = [
            {"type": "user", "text": idea},
            {"type": "bot", "text": reply}
        ]

        with get_db() as db:

            if chat:

                full_messages = old_messages + new_messages

                saved_chat = db.execute("""
                    UPDATE chats
                    SET messages = %s::jsonb,
                        updated_at = NOW()
                    WHERE id = %s AND user_id = %s
                    RETURNING id, title, messages, created_at, updated_at
                """, (
                    json.dumps(full_messages),
                    chat_id,
                    session["user_id"]
                )).fetchone()

            else:

                saved_chat = db.execute("""
                    INSERT INTO chats (user_id, title, messages)
                    VALUES (%s, %s, %s::jsonb)
                    RETURNING id, title, messages, created_at, updated_at
                """, (
                    session["user_id"],
                    idea[:60],
                    json.dumps(new_messages)
                )).fetchone()

            created_tasks = []

            if mode == "plan":

                for task in tasks:

                    saved_task = db.execute("""
                        INSERT INTO tasks (user_id, chat_id, title)
                        VALUES (%s, %s, %s)
                        RETURNING id, title, completed
                    """, (
                        session["user_id"],
                        saved_chat["id"],
                        task
                    )).fetchone()

                    created_tasks.append(saved_task)

        return jsonify({
            "success": True,
            "mode": mode,
            "reply": reply,
            "plan": reply,
            "chat": saved_chat,
            "tasks_created": len(created_tasks),
            "tasks": created_tasks
        })

    except Exception as error:

        app.logger.exception("AI request failed")

        return jsonify({
            "error": "Recoddly couldn't process your message.",
            "details": str(error)
        }), 502


# =====================================
# RECENT CHATS
# =====================================

@app.route("/api/chats")
@login_required
def get_chats():

    with get_db() as db:

        chats = db.execute("""
            SELECT id, title, messages, created_at, updated_at
            FROM chats
            WHERE user_id = %s
            ORDER BY updated_at DESC
        """, (session["user_id"],)).fetchall()

    return jsonify({"chats": chats})


@app.route("/api/chats/<int:chat_id>")
@login_required
def get_chat(chat_id):

    with get_db() as db:

        chat = db.execute("""
            SELECT id, title, messages, created_at, updated_at
            FROM chats
            WHERE id = %s AND user_id = %s
        """, (
            chat_id,
            session["user_id"]
        )).fetchone()

    if not chat:
        return jsonify({"error": "Chat not found."}), 404

    return jsonify({"chat": chat})


# =====================================
# DELETE CHAT + RELATED TASKS
# =====================================

@app.route("/api/chats/<int:chat_id>", methods=["DELETE"])
@login_required
def delete_chat(chat_id):

    with get_db() as db:

        deleted_chat = db.execute("""
            DELETE FROM chats
            WHERE id = %s AND user_id = %s
            RETURNING id
        """, (
            chat_id,
            session["user_id"]
        )).fetchone()

    if not deleted_chat:
        return jsonify({
            "success": False,
            "error": "Chat not found."
        }), 404

    return jsonify({
        "success": True,
        "message": "Chat and related tasks deleted successfully."
    })


# =====================================
# TASKS
# =====================================

@app.route("/api/tasks")
@login_required
def get_tasks():

    with get_db() as db:

        tasks = db.execute("""
            SELECT id, chat_id, title, completed, created_at
            FROM tasks
            WHERE user_id = %s
            ORDER BY created_at DESC, id DESC
        """, (session["user_id"],)).fetchall()

    return jsonify({"tasks": tasks})


@app.route("/api/tasks/<int:task_id>", methods=["PATCH"])
@login_required
def update_task(task_id):

    data = request.get_json(silent=True) or {}
    completed = data.get("completed")

    if not isinstance(completed, bool):
        return jsonify({
            "error": "Invalid task status."
        }), 400

    with get_db() as db:

        task = db.execute("""
            UPDATE tasks
            SET completed = %s
            WHERE id = %s AND user_id = %s
            RETURNING id
        """, (
            completed,
            task_id,
            session["user_id"]
        )).fetchone()

    if not task:
        return jsonify({
            "error": "Task not found."
        }), 404

    return jsonify({"success": True})


# =====================================
# OLD BROWSER DATA MIGRATION
# =====================================

@app.route("/api/migrate-local-data", methods=["POST"])
@login_required
def migrate_local_data():

    data = request.get_json(silent=True) or {}

    chats = data.get("chats", [])
    tasks = data.get("tasks", [])

    if not isinstance(chats, list) or not isinstance(tasks, list):
        return jsonify({
            "error": "Invalid migration data."
        }), 400

    id_map = {}

    with get_db() as db:

        for old_chat in chats:

            if not isinstance(old_chat, dict):
                continue

            title = str(
                old_chat.get("title", "Imported chat")
            )[:120]

            messages = old_chat.get("messages", [])

            if not isinstance(messages, list):
                messages = []

            saved = db.execute("""
                INSERT INTO chats (user_id, title, messages)
                VALUES (%s, %s, %s::jsonb)
                RETURNING id
            """, (
                session["user_id"],
                title,
                json.dumps(messages)
            )).fetchone()

            id_map[str(old_chat.get("id", ""))] = saved["id"]

        for old_task in tasks:

            if not isinstance(old_task, dict):
                continue

            title = str(old_task.get("title", "")).strip()

            if not title:
                continue

            new_chat_id = id_map.get(
                str(old_task.get("chatId", ""))
            )

            db.execute("""
                INSERT INTO tasks (user_id, chat_id, title, completed)
                VALUES (%s, %s, %s, %s)
            """, (
                session["user_id"],
                new_chat_id,
                title,
                bool(old_task.get("completed", False))
            ))

    return jsonify({"success": True})


# =====================================
# START APPLICATION
# =====================================

if __name__ == "__main__":

    try:
        initialize_database()
        print("PostgreSQL connected successfully!")

    except Exception:
        app.logger.exception("Database connection failed")

    app.run(debug=True)
