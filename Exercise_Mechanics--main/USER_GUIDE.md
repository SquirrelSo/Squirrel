# Exercise Mechanics User Guide

This guide explains how to install, start, and use the Exercise Mechanics web application in plain language.
It is written for someone running the application locally on a Mac for the first time.

## What Exercise Mechanics does

Exercise Mechanics uses your computer's camera to watch your exercise movement and provide live feedback. The
camera image is processed in the browser. The backend receives body-joint positions, counts your
reps or knee lifts, measures range of motion, calculates form scores, and saves workout reports.

The current usable exercises are:

- Squat
- Single Arm Bicep Curl
- Double Arm Bicep Curl
- High Knees
- Push-up

Lunges and Plank may be visible in the exercise library, but they are still marked **Coming Soon**.

> **Push-up is filmed from your side**, not facing you, because the two things it measures — how far
> your elbows bend and whether your body stays in a straight line — cannot be seen from the front.
> Setup will not begin a set until the camera is beside you, and if you turn to face it mid-set the
> app says so and stops counting reps until you turn back.

> **The app currently opens straight on a push-up set.** It skips the profile and workout-building
> steps described below and puts you on the setup screen immediately. To use the full journey
> instead, add `?demo=off` to the address — for example `http://localhost:8000/?demo=off`. (A
> developer can make that the default again: see "The app currently opens straight on a push-up set"
> in [`README.md`](README.md).)

The overall journey, with the demo switched off, is:

```text
Install once → Start the server → Open the web page → Create or select a profile
→ Save a skill level → Choose Solo Training → Add one exercise → Allow the camera
→ Complete setup → Exercise → Read the summary and report
```

> **Current prototype limitation:** Start a workout with exactly one exercise in **Your Plan**.
> The page can display recommended plans containing several exercises, but the backend currently
> runs one exercise at a time.

---

## Part 1: Install the application for the first time

You only need to complete this part once on a computer.

> **About the project path:** wherever you cloned or unzipped the project, that folder is your
> project folder. This guide writes it as `~/exercise-mechanics` — replace `~/exercise-mechanics` with your actual path in
> every command below.

### Step 0: Get the project code

If the project was shared as a Git repository, clone it and move into the folder:

```bash
git clone <repository-url> ~/exercise-mechanics
cd ~/exercise-mechanics
```

If it was shared as a zip archive instead, unzip it and move into the unzipped folder:

```bash
cd ~/exercise-mechanics
```

Everything after this assumes you are inside the project folder.

### Step 1: Make sure the required software is installed

Exercise Mechanics expects:

- Python 3.11
- Node.js 22.12 or newer
- npm 10.x
- A modern browser with camera access, such as Chrome or Edge

Open the macOS **Terminal** application and check the installed versions:

```bash
python3 --version
node --version
npm --version
```

You should see version numbers. If Terminal says `command not found`, install the missing software
before continuing.

> **Exact pinned versions:** the project ships a `.python-version` (`3.11.9`) and a `.nvmrc`
> (`22.22.3`). If you use `pyenv` and `nvm`, running `pyenv install` and `nvm use` from the project
> folder selects those exact versions automatically.

### Step 2: Open the project folder in Terminal

Copy and run this command:

```bash
cd ~/exercise-mechanics
```

This tells Terminal to work inside the Exercise Mechanics project folder.

You can confirm that you are in the correct folder by running:

```bash
pwd
```

It should print the full path to your project folder, and that folder should contain `backend/`,
`frontend-react/`, and `requirements.txt`.

### Step 3: Create the Python virtual environment

A virtual environment is a private container for this project's Python libraries. It prevents the
project from interfering with other Python applications on your computer.

Run:

```bash
python3 -m venv .venv
```

If a `.venv` folder already exists and works, skip this creation command.

### Step 4: Activate the virtual environment

Run:

```bash
source .venv/bin/activate
```

After activation, Terminal usually shows `(.venv)` at the beginning of the command line. That means
commands such as `python` and `pip` now use this project's private environment.

### Step 5: Install the Python libraries

Make sure the virtual environment is active, then run:

```bash
python -m pip install -r requirements.txt
```

This installs the backend libraries, including FastAPI, Uvicorn, PyYAML, and the test tools.

Wait until the command completes without a red error message.

### Step 6: Install the web-page libraries

Run:

```bash
cd frontend-react
npm ci
cd ..
```

`npm ci` installs the exact frontend library versions recorded by the project. The final `cd ..`
returns Terminal to the main project folder.

### Step 7: Build the web page

Run:

```bash
cd frontend-react
npm run build
cd ..
```

This converts the frontend source code into the web page served by the backend. A successful build
ends with a message similar to `built in ...`.

### Step 8: Verify the installation (recommended)

Before opening the browser, confirm the environment is wired correctly. With the virtual environment
active, run the backend tests from the project folder:

```bash
python -m pytest -q
```

Then run the frontend tests:

```bash
cd frontend-react
npm test
cd ..
```

Both should finish with every test passing. If they do, your setup is good.

The one-time installation is now complete.

---

## Part 2: Start Exercise Mechanics

### Step 1: Open Terminal and go to the project

```bash
cd ~/exercise-mechanics
```

### Step 2: Activate the virtual environment

```bash
source .venv/bin/activate
```

### Step 3: Build the latest web page

Do this after the frontend code has changed. It is also safe to do before every run:

```bash
cd frontend-react
npm run build
cd ..
```

### Step 4: Start the backend and web server

Run:

```bash
.venv/bin/python -m uvicorn backend.main:app --reload --port 8000
```

High Knees no longer needs a special terminal flag. Use the same command for every exercise. The
`--reload` flag restarts the server automatically when backend code changes, so you do not need to
stop and restart it after editing Python files.

When startup succeeds, Terminal displays a message similar to:

```text
Uvicorn running on http://127.0.0.1:8000
```

Keep this Terminal window open while using Exercise Mechanics. Closing it stops the application.

### Step 5: Open the web application

Open Chrome or Edge and visit:

[http://localhost:8000](http://localhost:8000)

Terminal may print the address as `http://127.0.0.1:8000`; that is the same thing, and the camera
works on either because both count as secure local addresses. (The camera will not work if you open
the app over a plain network IP address instead of `localhost`.)

If you changed the frontend and still see an older page, perform a hard refresh:

- Chrome on Mac: `Command + Shift + R`
- Chrome on Windows: `Ctrl + Shift + R`

---

## Part 3: Create or select a user profile

### New user

1. On the first Exercise Mechanics screen, scroll down or click **Scroll**.
2. Click **Join Exercise Mechanics**.
3. Complete all fields under:
   - Identity
   - Body metrics
   - Contact
4. Enter height in centimetres and weight in kilograms.
5. Click **Create profile**.
6. Exercise Mechanics saves the profile and opens the dashboard.

### Existing user

1. Scroll down on the first screen.
2. Click **Login**.
3. Select the correct profile card.
4. Click **Continue**.

The **Login** button appears only when this browser already knows at least one saved profile.

---

## Part 4: Set the user's skill level

The dashboard opens on the **Home** tab.

1. Find the **Skill Level** card.
2. Select **Beginner**, **Intermediate**, or **Advanced**.
3. Click **Update**.
4. Wait until the card shows **Updated**.

The saved skill level is attached to future workout sessions. For a new or returning casual user,
**Beginner** is the safest starting point.

The BMI and schedule cards are informational. The Fitness Assessment button is not required to
start the current prototype workout flow.

---

## Part 5: Choose Solo Training

1. Click **Training** in the top navigation bar.
2. Find the **Solo Training** card marked **Available**.
3. Click **Start session**.

**Group Class** and **1:1 Coaching** are not available yet.

---

## Part 6: Build a workout

### Step 1: Choose a goal

The application asks, **What's your goal today?** Choose one of these options:

- **Strength** — intended for exercises such as Squat and Bicep Curl.
- **Full-Body Conditioning** — displays a circuit-style plan.
- **HIIT** — intended for timed work such as High Knees.
- **Free Session** — lets you browse the full library directly.

For the simplest one-exercise test, choose **Free Session**.

### Step 2: Choose one exercise

Find the exercise card and click **Add to workout**.

Use only one of these enabled choices:

- Squat
- Single Arm Bicep Curl
- Double Arm Bicep Curl
- High Knees

The selected exercise appears in **Your Plan** on the right side.

Do not add more than one exercise. If a recommended plan adds several exercises, remove the extra
ones using the `×` button until only one remains.

### Step 3: Configure the workout

For Squat or Bicep Curl, set:

- **Sets** — how many groups of reps you want to perform.
- **Reps** — how many repetitions are expected in each set.
- **Set interval** — rest time between sets, when using more than one set.

For High Knees, set:

- **Sets** — how many timed sets you want to perform.
- **Duration** — the number of seconds in each set.
- **Set interval** — rest time between sets, when using more than one set.

Use the `−` and `+` buttons beside each value. A short first test, such as one set, is easier for
checking camera position and understanding the feedback.

### Step 4: Start

Click **Start Training**. Exercise Mechanics first saves the session and then opens the camera/setup screen.

If the page says that Prototype 1 starts one exercise at a time, remove exercises until only one is
left in **Your Plan**, then click **Retry Start**.

---

## Part 7: Allow and position the camera

### Allow camera access

When the browser asks for permission, click **Allow**.

If Exercise Mechanics shows **Camera access needed**, click **Start camera**. If it shows **Camera access
blocked**:

1. Click the camera or lock icon beside the browser address.
2. Change Camera permission to **Allow**.
3. Reload the page and try again.
4. On macOS, also check **System Settings → Privacy & Security → Camera** and allow the browser.

### Position yourself

1. Place the camera directly in front of you.
2. Keep the camera stable and level.
3. Use good lighting so your body is clearly visible.
4. Step backward until the body parts requested on screen are inside the picture.
5. Avoid having another person enter the camera view.
6. Follow any stance or posture instruction displayed by Exercise Mechanics.

The setup process has three automatic stages:

1. **Setup check** — confirms that the required body joints are visible and your starting position
   is acceptable.
2. **Baseline capture** — asks you to hold still briefly so Exercise Mechanics can learn your neutral starting
   position for that set.
3. **START** — appears when setup is complete; the workout then begins automatically.

You do not need to press a separate calibration button.

### Exercise-specific starting position

- **Squat:** Face the camera. Keep both legs, knees, ankles, hips, and shoulders visible. Follow the
  stance-width message before starting.
- **Single Arm Bicep Curl:** Face the camera. Keep both shoulders, elbows, and wrists visible. Curl
  only the arm selected by the exercise.
- **Double Arm Bicep Curl:** Face the camera. Keep both arms visible and curl both arms together.
- **High Knees:** Face the camera. Keep shoulders, hips, knees, and ankles visible. Stand upright
  with the stance requested on screen.

---

## Part 8: Understand the live workout screen

The live screen contains the following information:

| Screen item | Meaning |
|---|---|
| Timer | Rep workouts show elapsed time. High Knees shows the backend-controlled time remaining. |
| Form score | The score for the latest completed rep or knee lift during the live workout. |
| ROM bar | How far the movement has travelled toward the exercise's full-range target. |
| Reps or counted lifts | The number of movements Exercise Mechanics accepted. |
| Full, shallow, or invalid | Whether the completed movement reached the expected range and quality. |
| Pace (now) / Avg pace | For High Knees, your current knee-lift pace and your set-average pace, both per minute (`/min`). Rep-based exercises show tempo instead. |
| Coaching message | The most important correction to make at that moment. |
| Skeleton | Shows the body joints Exercise Mechanics is currently tracking. |

### Skeleton colours

- **Green** — the tracked area is currently within the expected range.
- **Red** — Exercise Mechanics has confirmed a form issue in that body area.
- **Dim or missing** — tracking confidence is low or the required joint is not visible.

For High Knees, confirmed knee-tracking faults turn the affected leg red, and confirmed torso lean
turns the torso red. A shallow knee lift can reduce the form score and show a coaching message
without colouring the skeleton.

### Live controls

- **Back arrow / Exit** — stops the workout and returns to the exercise area.
- **Pause** — available for rep-based exercises such as Squat and Bicep Curl.
- High Knees is timer-based and does not currently offer pause/resume.

If tracking is lost, return your full body to the camera view and hold still briefly. Exercise Mechanics pauses
credit while the connection or required landmarks are unavailable.

---

## Part 9: Complete sets and rests

When a set finishes:

- If more sets remain, Exercise Mechanics displays a rest countdown.
- When rest reaches zero, the next set returns to the setup check and captures a fresh baseline.
- Complete the requested setup position again before the next set starts.
- After the final set, Exercise Mechanics opens the workout summary.

For High Knees, the displayed completed-set time comes from the duration selected in the workout
plan, not from extra time spent in setup.

---

## Part 10: Read the workout summary

For rep-based exercises, the summary can show:

- Average form score for the workout
- Completed sets and reps
- Good, fair, flagged, or low-coverage reps
- Total workout time
- Range-of-motion consistency
- Best set
- Main areas to improve

For High Knees, the summary can show:

- Average form score
- Completed timed sets
- Counted, full, shallow, and invalid lifts
- Left and right lift totals
- Total configured workout time
- Left/right knee-travel comparison when enough lifts were captured
- Main movement faults flagged during the set (for example knee tracking or torso lean), shown as
  focus areas — or a "clean set" note when there were none

Use **Start again** when it is available to repeat a rep workout. Use **Exit** to return to the Solo
Training area.

The live form score describes the latest completed movement. The summary and detailed report
combine the results from the completed set or workout.

---

## Part 11: Open Analytics & Insights

1. Exit the completed workout.
2. In the Solo Training area, click **Analytics & Insights** at the top.
3. Select a saved session.
4. Open the exercise inside that session to view its detailed report.

The analytics pages build up after completed workouts. A new profile with no finished workout will
show an empty-state message.

Use **Exercise Library** to return to workout selection, or **Home** to return to the main dashboard.

---

## Part 12: Log out and stop the application

### Log out of the web page

1. Return to the main dashboard.
2. Click the profile avatar in the top-right corner.
3. Click **Log out**.

Logging out does not delete the local profile. It remains available through **Login** next time.

### Stop the local server

Return to the Terminal window running Uvicorn and press:

```text
Control + C
```

To leave the Python virtual environment, run:

```bash
deactivate
```

---

## Quick start on later days

After the one-time installation, the normal startup is:

```bash
cd ~/exercise-mechanics
source .venv/bin/activate
cd frontend-react
npm run build
cd ..
.venv/bin/python -m uvicorn backend.main:app --reload --port 8000
```

Then open [http://localhost:8000](http://localhost:8000).

---

## Common problems

### `python3: command not found`

Python is not installed or is not available in Terminal. Install Python 3.11 and reopen Terminal.

### `npm: command not found`

Node.js is not installed. Install the supported Node.js version and reopen Terminal.

### `No module named fastapi`, `uvicorn`, or `yaml`

The Python libraries are missing or the wrong environment is active. From the project folder, run:

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### The page does not open

- Confirm the Uvicorn Terminal window is still running.
- Confirm the address is exactly [http://localhost:8000](http://localhost:8000).
- Read the last Terminal message for an error.

### Port 8000 is already in use

Another server is already using the port. Find the older Terminal window and stop it with
`Control + C`, then start Exercise Mechanics again.

### The web page looks old or High Knees says Coming Soon

Rebuild the frontend, restart the backend, and hard-refresh the browser:

```bash
cd ~/exercise-mechanics/frontend-react
npm run build
cd ..
.venv/bin/python -m uvicorn backend.main:app --reload --port 8000
```

### The camera is black or blocked

- Allow camera access in the browser.
- Allow the browser under macOS **Privacy & Security → Camera**.
- Close other applications that may be using the camera.
- Reload Exercise Mechanics and click **Try again**.

### Setup does not finish

- Step back until every requested body part is visible.
- Improve the lighting.
- Face the camera directly.
- Correct the stance or posture named in the setup message.
- Hold still while the baseline progress completes.

### Reps or lifts are not counted

- Keep the required joints inside the picture throughout the movement.
- Return fully to the starting position between reps or knee lifts.
- Avoid moving too quickly during the first test.
- Watch the range-of-motion bar and the tracking message.

### The form score is missing or marked unreliable

Exercise Mechanics did not receive enough trustworthy joint data. Improve camera position and lighting, keep the
full required body area visible, and repeat the set.

---

## Where workout data is stored

Local user profiles and session data are stored under:

```text
data/users/<user-id>/
```

Each completed session has its own folder under the user's `sessions` directory. This data can
contain personal workout information and should not be shared publicly.

---

## First-session checklist

Before pressing **Start Training**, confirm:

- The backend Terminal is running without errors.
- The browser is open at `http://localhost:8000`.
- The correct user profile is selected.
- The skill level has been saved.
- Exactly one enabled exercise is in **Your Plan**.
- Sets, reps or duration, and rest are correct.
- The camera is stable and directly in front of you.
- The room is well lit.
- Your required body joints can fit inside the camera view.
