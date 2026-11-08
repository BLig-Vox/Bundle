"""Dependency-free Firefox acceptance against the generated Vite + SQLite app.
Run: python3 frontend.py http://127.0.0.1:5173. Uses a private Firefox profile.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error, http.cookiejar

origin = sys.argv[1]
firefox = os.environ.get('BUNDLE_FIREFOX') or shutil.which('firefox')
if not firefox:
    raise SystemExit('Firefox unavailable: install Firefox or set BUNDLE_FIREFOX; browser acceptance did not run.')

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

with tempfile.TemporaryDirectory(prefix='bundle-firefox-') as profile:
    port = free_port()
    with open(profile + '/user.js', 'w') as f:
        f.write(f'user_pref("marionette.port", {port});\nuser_pref("browser.shell.checkDefaultBrowser", false);\n')
    log = open(profile + '/firefox.log', 'w')
    browser = subprocess.Popen([firefox, '--headless', '--no-remote', '--profile', profile, '--marionette'], stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 25
        while True:
            try:
                conn = socket.create_connection(('127.0.0.1', port), timeout=2)
                break
            except OSError:
                if time.monotonic() > deadline:
                    log.flush()
                    raise RuntimeError(open(profile + '/firefox.log').read())
                time.sleep(.1)
        conn.settimeout(15)
        def receive():
            size = b''
            while not size.endswith(b':'):
                size += conn.recv(1)
            count = int(size[:-1]); data = b''
            while len(data) < count:
                data += conn.recv(count - len(data))
            return json.loads(data)
        receive()
        sequence = 0
        def command(name, params=None):
            global sequence
            sequence += 1
            payload = json.dumps([0, sequence, name, params or {}]).encode()
            conn.sendall(str(len(payload)).encode() + b':' + payload)
            result = receive()
            if result[2]: raise RuntimeError(result[2])
            return result[3]
        command('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': False}}})
        def js(script):
            return command('WebDriver:ExecuteScript', {'script': script, 'args': [], 'newSandbox': False})['value']
        def wait(script, label):
            until = time.monotonic() + 12
            while time.monotonic() < until:
                if js(script): return
                time.sleep(.05)
            raise AssertionError(label + ': ' + js('return document.body.innerText'))
        def click(text):
            assert js('const b = [...document.querySelectorAll("button")].find(b => b.textContent === ' + json.dumps(text) + '); if (!b || b.disabled) return false; b.click(); return true;'), 'Enabled button missing: ' + text
        def fill(label, value):
            # Native setter + input event exercises the real controlled React form.
            assert js('const l = [...document.querySelectorAll("label")].find(l => l.textContent === ' + json.dumps(label) + '); if (!l) return false; const e = document.getElementById(l.htmlFor); const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(e, ' + json.dumps(value) + '); e.dispatchEvent(new Event("input", {bubbles:true})); return true;'), 'Missing accessible label: ' + label
        def submit():
            js('document.querySelector("form").requestSubmit(); return true;')
        def navigate(hash):
            assert js('const a = document.querySelector(' + json.dumps('a[href="' + hash + '"]') + '); if (!a) return false; a.click(); return true;'), 'Visible navigation missing: ' + hash
        def api(path, method='GET', body=None):
            options = {'method': method, 'credentials': 'same-origin', 'cache': 'no-store'}
            if body is not None:
                options.update({'headers': {'Content-Type': 'application/json'}, 'body': json.dumps(body)})
            return command('WebDriver:ExecuteAsyncScript', {'script': 'const done = arguments[arguments.length-1]; fetch(' + json.dumps(path) + ', ' + json.dumps(options) + ').then(async r => done({status:r.status, body: r.status === 204 ? null : await r.json().catch(() => null)})).catch(e => done({error:String(e)}));', 'args': [], 'newSandbox': False})['value']
        def signed_out():
            wait('return !!document.getElementById("email") && !document.getElementById("email").disabled', 'Account form renders')
            js('location.hash = "#/notes"; return true;')
        suffix = str(time.time_ns())
        first = 'browser-' + suffix + '@example.com'
        second = 'other-' + suffix + '@example.com'
        password = 'browser acceptance password!'
        command('WebDriver:Navigate', {'url': origin})
        signed_out()  # RED: old status-only App has no accessible account form.
        click('Create an account')
        fill('Email', first); fill('Password', password); submit()
        wait('return document.body.innerText.includes(' + json.dumps(first) + ') && document.body.innerText.includes("No notes yet")', 'Register and empty Notes')
        fill('Note', '<script>private note</script>'); submit()
        wait('return [...document.querySelectorAll("li")].some(e => e.textContent === "<script>private note</script>")', 'Create and render escaped note')
        assert js('return !document.querySelector("li script")'), 'Note must render as text'
        command('WebDriver:Refresh')
        wait('return [...document.querySelectorAll("li")].some(e => e.textContent === "<script>private note</script>")', 'Cookie session restores account and Notes')
        assert js('return !document.cookie.includes("bundle_session") && localStorage.length === 0 && sessionStorage.length === 0'), 'HTTP-only session; no browser storage'
        navigate('#/tasks')
        wait('return document.body.innerText.includes("No Task yet")', 'Generated Task empty page')
        fill('title', 'browser private task')
        js('document.getElementById("Task-body-null").click(); return true;')
        fill('body', 'details'); fill('count', '2'); fill('price', '1.25'); submit()
        wait('return !!document.querySelector(\'button[aria-label^="Edit Task"]\')', 'Task create/list')
        rows = api('/api/tasks')['body']
        assert len(rows) == 1 and rows[0]['body'] == 'details', rows
        task_id = rows[0]['id']
        command('WebDriver:Refresh')
        wait('return !!document.querySelector(\'button[aria-label^="Edit Task"]\')', 'Task route and persistence restore')
        click('Log out'); signed_out()
        assert not js('return document.body.innerText.includes("private note")'), 'Logout clears private data'
        click('Create an account'); fill('Email', second); fill('Password', password); submit()
        wait('return document.body.innerText.includes(' + json.dumps(second) + ') && document.body.innerText.includes("No notes yet")', 'Second account isolation')
        navigate('#/tasks')
        wait('return document.body.innerText.includes("No Task yet")', 'Second account Task isolation')
        assert api('/api/tasks')['body'] == []
        for method in ['GET', 'PATCH', 'DELETE']:
            assert api('/api/tasks/' + str(task_id), method, {'body': None} if method == 'PATCH' else None)['status'] == 404
        navigate('#/notes')
        click('Log out'); signed_out()
        fill('Email', first); fill('Password', password); submit()
        wait('return document.body.innerText.includes("private note")', 'Login restores only first account Notes')
        navigate('#/tasks')
        wait('return !!document.querySelector(\'button[aria-label^="Edit Task"]\')', 'First account Task persists')
        click('Edit Task ' + str(task_id))
        js('document.getElementById("Task-body-null").click(); return true;')
        click('Save Task')
        wait('return document.body.innerText.includes("Task saved")', 'Nullable PATCH')
        assert api('/api/tasks')['body'][0]['body'] is None
        click('Delete Task ' + str(task_id))
        wait('return document.body.innerText.includes("No Task yet")', 'Delete Task')
        assert api('/api/tasks')['body'] == []
        navigate('#/notes')
        wait('return document.body.innerText.includes("private note")', 'Notes preserved')
        # A second HTTP device keeps its own cookie jar across the UI rotation.
        jar = http.cookiejar.CookieJar()
        device = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        payload = json.dumps({'email': first, 'password': password}).encode()
        assert device.open(urllib.request.Request(origin + '/api/auth/login', data=payload, headers={'Origin': origin, 'Content-Type': 'application/json'})).status == 200
        click('Account')
        wait('return !!document.querySelector(\'ul[aria-label="Your sessions"] li\') && document.body.innerText.includes("Current session")', 'Sessions list and current marker')
        sessions = api('/api/auth/sessions')['body']
        assert len(sessions) == 2 and all(set(row) == {'id', 'expiresAt', 'current'} for row in sessions), sessions
        current = next(row for row in sessions if row['current'])
        other = next(row for row in sessions if not row['current'])
        assert api('/api/auth/sessions/' + str(current['id']), 'DELETE')['status'] == 409
        click('Revoke session ' + str(other['id']))
        wait('return document.querySelectorAll(\'ul[aria-label="Your sessions"] li\').length === 1', 'Revocation refreshes sessions')
        try:
            device.open(origin + '/api/auth/me')
            raise AssertionError('Revoked session remained authorized')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        # Reauthenticate the independent device for password rotation acceptance.
        assert device.open(urllib.request.Request(origin + '/api/auth/login', data=payload, headers={'Origin': origin, 'Content-Type': 'application/json'})).status == 200
        js('window.passwordRequests = 0; const original = window.fetch; window.fetch = (...args) => { if (args[0] === "/api/auth/password") window.passwordRequests++; return original(...args); }; return true;')
        def change(current, new, confirm):
            fill('Current password', current); fill('New password', new); fill('Confirm new password', confirm)
            js("document.querySelector('form[aria-label=\"Change password\"]').requestSubmit(); return true;")
        change(password, password, 'mismatched confirmation')
        wait('return document.body.innerText.includes("Passwords must match")', 'Confirmation validation')
        assert js('return window.passwordRequests === 0'), 'Invalid form must not send password request'
        change(password, '😀' * 257, '😀' * 257)
        wait('return document.body.innerText.includes("1024 UTF-8 bytes")', 'UTF-8 validation')
        assert js('return window.passwordRequests === 0')
        change('wrong current password!', password, password)
        wait('return document.body.innerText.includes("Could not change password") && !document.getElementById("current-password").disabled', 'Wrong current password remains signed in')
        assert api('/api/auth/me')['status'] == 200
        new_password = '  é😀 browser new password!  '
        change(password, new_password, new_password)
        wait('return document.body.innerText.includes("Password changed")', 'Password rotation succeeds')
        assert js('return ["current-password", "new-password", "confirm-password"].every(id => document.getElementById(id).value === "")')
        assert api('/api/auth/me')['status'] == 200
        try:
            device.open(origin + '/api/auth/me')
            raise AssertionError('Prior device remained authorized')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        assert api('/api/auth/login', 'POST', {'email': first, 'password': password})['status'] == 401
        command('WebDriver:Refresh')
        wait('return document.body.innerText.includes(' + json.dumps(first) + ') && document.body.innerText.includes("private note")', 'Rotated HTTP-only cookie restores session and Notes')
        assert js('return !document.cookie.includes("bundle_session") && localStorage.length === 0 && sessionStorage.length === 0')
        click('Log out'); signed_out()
        fill('Email', first); fill('Password', new_password); submit()
        wait('return document.body.innerText.includes("private note")', 'New password login preserves Notes')
        click('Log out'); signed_out()
        assert api('/api/tasks')['status'] == 401
        print('Firefox SQLite UI PASS: minimal session listing/current refusal/per-session revocation, password validation/wrong-current/rotation/device revocation/new login, register/login, Task navigation/create/list/PATCH null/delete, API persistence/owner isolation, Notes, refresh, HTTP-only cookie, logout.', flush=True)
        command('WebDriver:DeleteSession')
    finally:
        browser.terminate()
        try: browser.wait(timeout=5)
        except subprocess.TimeoutExpired: browser.kill(); browser.wait()
        log.close()
