// =====================================================
// Secure Video Chat - フロントエンド アプリケーション
// =====================================================

// ★★★ ここにGASのウェブアプリURLを設定してください ★★★
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzTssqitUmWhsAg-sfaFaIknvH0tywO6NKLWjYfPTXnVHTfbR7p4qcqdAYH0Fu9Fm6o/exec';

// =====================================================
// 暗号化ユーティリティ
// =====================================================
class CryptoUtil {
    static async generateKey() {
        return await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
    }

    static async exportKey(key) {
        const exported = await window.crypto.subtle.exportKey("raw", key);
        return Array.from(new Uint8Array(exported))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    static async importKey(keyData) {
        const keyBytes = new Uint8Array(keyData.match(/.{2}/g).map(b => parseInt(b, 16)));
        return await window.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", true, ["encrypt", "decrypt"]);
    }

    static async encrypt(key, data) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
        return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
    }

    static async decrypt(key, iv, encryptedData) {
        return await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(iv) },
            key,
            new Uint8Array(encryptedData)
        );
    }
}

// =====================================================
// GAS APIクライアント
// =====================================================
class GasAPI {
    static async call(params) {
        const url = new URL(GAS_URL);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
        console.log('[GAS] →', params.action, url.toString());
        const res = await fetch(url.toString());
        const json = await res.json();
        console.log('[GAS] ←', params.action, json);
        return json;
    }

    static register(name, password) {
        return this.call({ action: 'register', name, password });
    }
    static login(name, password, peerId) {
        return this.call({ action: 'login', name, password, peer_id: peerId || '' });
    }
    static logout(token) {
        return this.call({ action: 'logout', token });
    }
    static heartbeat(token, peerId) {
        return this.call({ action: 'heartbeat', token, peer_id: peerId || '' });
    }
    static onlineList(token) {
        return this.call({ action: 'online_list', token });
    }
    static sendSignal(token, to, type, signalData) {
        // signalDataはencodeURIComponentで確実にエンコード
        return this.call({ action: 'send_signal', token, to, type, signal_data: signalData || '' });
    }
    static getSignals(token) {
        return this.call({ action: 'get_signals', token });
    }
    static ackSignal(token, signalId) {
        return this.call({ action: 'ack_signal', token, signal_id: signalId });
    }
}

// =====================================================
// メインアプリケーション
// =====================================================
class SecureVideoChat {
    constructor() {
        // 認証情報
        this.token = localStorage.getItem('svc_token') || null;
        this.myName = localStorage.getItem('svc_name') || null;

        // PeerJS / 通話
        this.peer = null;
        this.currentCall = null;
        this.dataConnection = null;
        this.localStream = null;
        this.encryptionKey = null;
        this.isAudioEnabled = true;
        this.isVideoEnabled = true;
        this.isMediaReady = false;
        this.audioContext = null;
        this.gainNode = null;
        this.currentVolume = 100;
        this.disconnectedBySelf = false;
        this.isDisconnecting = false; // 切断処理中フラグ（二重発火防止）
        this.isVolumeControlVisible = false;
        this.isKeyVisible = false;

        // シグナリング
        this.pollingInterval = null;
        this.heartbeatInterval = null;
        this.pendingSignal = null; // 着信時の保留シグナル
        this.callTargetName = null; // 発信先の名前

        this.initElements();
        this.setupAuthEvents();
        this.setupMainEvents();
        this.setupPermissionModal();

        // 既存セッションがあれば自動ログイン（サーバー側でトークンを検証してから画面遷移）
        if (this.token && this.myName) {
            this.validateSessionAndEnter();
        }

        window.addEventListener('beforeunload', () => this.onBeforeUnload());
    }

    // =====================================================
    // 要素取得
    // =====================================================
    initElements() {
        this.el = {
            // 画面
            authScreen: document.getElementById('authScreen'),
            mainScreen: document.getElementById('mainScreen'),

            // 認証
            loginForm: document.getElementById('loginForm'),
            registerForm: document.getElementById('registerForm'),
            loginName: document.getElementById('loginName'),
            loginPassword: document.getElementById('loginPassword'),
            loginBtn: document.getElementById('loginBtn'),
            loginError: document.getElementById('loginError'),
            registerName: document.getElementById('registerName'),
            registerPassword: document.getElementById('registerPassword'),
            registerBtn: document.getElementById('registerBtn'),
            registerError: document.getElementById('registerError'),

            // ヘッダー
            headerUserName: document.getElementById('headerUserName'),
            logoutBtn: document.getElementById('logoutBtn'),
            connectionStatus: document.getElementById('connectionStatus'),
            statusIndicator: document.getElementById('statusIndicator'),
            securityToggleBtn: document.getElementById('securityToggleBtn'),
            securityPanel: document.getElementById('securityPanel'),
            localPeerId: document.getElementById('localPeerId'),
            encryptionKey: document.getElementById('encryptionKey'),

            // ユーザーリスト
            userList: document.getElementById('userList'),
            refreshListBtn: document.getElementById('refreshListBtn'),

            // ビデオ
            waitingState: document.getElementById('waitingState'),
            videoGrid: document.getElementById('videoGrid'),
            localVideo: document.getElementById('localVideo'),
            remoteVideo: document.getElementById('remoteVideo'),
            localName: document.getElementById('localName'),
            remoteName: document.getElementById('remoteName'),
            callControls: document.getElementById('callControls'),
            disconnectButton: document.getElementById('disconnectButton'),
            toggleMicButton: document.getElementById('toggleMicButton'),
            toggleVideoButton: document.getElementById('toggleVideoButton'),
            connectionQuality: document.getElementById('connectionQuality'),
            volumeControlButton: document.getElementById('volumeControlButton'),
            volumeSlider: document.getElementById('volumeSlider'),
            volumeSliderContainer: document.querySelector('.volume-slider-container'),
            volumeValue: document.getElementById('volumeValue'),
            boostBadge: document.getElementById('boostBadge'),

            // モーダル
            incomingCallModal: document.getElementById('incomingCallModal'),
            incomingCallerName: document.getElementById('incomingCallerName'),
            acceptCallBtn: document.getElementById('acceptCallBtn'),
            rejectCallBtn: document.getElementById('rejectCallBtn'),
            callingModal: document.getElementById('callingModal'),
            callingTargetName: document.getElementById('callingTargetName'),
            cancelCallBtn: document.getElementById('cancelCallBtn'),
            notificationModal: document.getElementById('notificationModal'),
            permissionModal: document.getElementById('permissionModal'),
            permissionStartBtn: document.getElementById('permissionStartBtn'),
            permissionCloseBtn: document.getElementById('permissionCloseBtn'),

            // フッター
            shiftShortcutUrl: document.getElementById('shiftShortcutUrl'),
            saveShortcutBtn: document.getElementById('saveShortcutBtn'),
            shortcutSavedMsg: document.getElementById('shortcutSavedMsg'),
        };
    }

    // =====================================================
    // 権限説明モーダル（初回のみ自動表示）
    // =====================================================
    setupPermissionModal() {
        const CONSENT_KEY = 'svc_permission_consented';
        const modal = this.el.permissionModal;
        const startBtn = this.el.permissionStartBtn;
        const closeBtn = this.el.permissionCloseBtn;

        if (!modal) return;

        const alreadyConsented = localStorage.getItem(CONSENT_KEY) === '1';

        // 初回のみ自動表示
        if (!alreadyConsented) {
            modal.classList.add('visible');
            // 閉じるボタンは初回は無効化
            if (closeBtn) closeBtn.style.display = 'none';
        }

        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                startBtn.disabled = true;
                startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 許可を確認中...';

                // ブラウザのカメラ・マイク許可ダイアログをここで出す
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                    // 取得したストリームはすぐ停止（enterMainScreen時に再取得する）
                    stream.getTracks().forEach(t => t.stop());
                } catch (e) {
                    // 拒否・エラーでも先に進める（後で再度促す）
                    console.warn('権限取得エラー:', e);
                }

                modal.classList.remove('visible');
                localStorage.setItem(CONSENT_KEY, '1');

                // ポップアップ許可テスト（ユーザー操作中に実行）
                const testPopup = window.open('', '_blank', 'width=1,height=1');
                if (testPopup) testPopup.close();
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (localStorage.getItem(CONSENT_KEY) === '1') {
                    modal.classList.remove('visible');
                }
            });
        }
    }

    // =====================================================
    // 認証画面イベント
    // =====================================================
    setupAuthEvents() {
        // タブ切り替え
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const target = tab.dataset.tab;
                this.el.loginForm.style.display = target === 'login' ? '' : 'none';
                this.el.registerForm.style.display = target === 'register' ? '' : 'none';
                this.el.loginError.textContent = '';
                this.el.registerError.textContent = '';
            });
        });

        // パスワード表示切り替え
        document.querySelectorAll('.pw-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                const icon = btn.querySelector('i');
                if (input.type === 'password') {
                    input.type = 'text';
                    icon.className = 'fas fa-eye';
                } else {
                    input.type = 'password';
                    icon.className = 'fas fa-eye-slash';
                }
            });
        });

        // ログイン
        this.el.loginBtn.addEventListener('click', () => this.doLogin());
        this.el.loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        this.el.loginName.addEventListener('keydown', e => { if (e.key === 'Enter') this.el.loginPassword.focus(); });

        // 登録
        this.el.registerBtn.addEventListener('click', () => this.doRegister());
        this.el.registerPassword.addEventListener('keydown', e => { if (e.key === 'Enter') this.doRegister(); });
    }

    // =====================================================
    // 起動時セッション検証（タブ再開時に一瞬ログイン状態になるバグ対策）
    // =====================================================
    async validateSessionAndEnter() {
        // 画面はまだ認証画面のまま（enterMainScreenを呼ばない）
        try {
            const res = await GasAPI.heartbeat(this.token, '');
            if (res.ok) {
                // トークンが有効なのでメイン画面へ
                this.enterMainScreen();
            } else {
                // 無効なトークン → localStorageをクリアして認証画面を表示
                this.clearLocalSession();
            }
        } catch (e) {
            // ネットワークエラーの場合はオフラインの可能性があるのでそのままログイン画面
            this.clearLocalSession();
        }
    }

    clearLocalSession() {
        this.token = null;
        this.myName = null;
        localStorage.removeItem('svc_token');
        localStorage.removeItem('svc_name');
    }

    async doLogin() {
        const name = this.el.loginName.value.trim();
        const password = this.el.loginPassword.value.trim();
        this.el.loginError.textContent = '';

        if (!name || !password) {
            this.el.loginError.textContent = '名前とパスワードを入力してください';
            return;
        }

        this.el.loginBtn.disabled = true;
        this.el.loginBtn.textContent = 'ログイン中...';

        try {
            // ピアIDはログイン後に取得するので空で送る
            const res = await GasAPI.login(name, password, '');
            if (res.ok) {
                this.token = res.token;
                this.myName = res.name;
                localStorage.setItem('svc_token', this.token);
                localStorage.setItem('svc_name', this.myName);
                this.enterMainScreen();
            } else {
                this.el.loginError.textContent = res.error || 'ログインに失敗しました';
            }
        } catch (e) {
            this.el.loginError.textContent = 'サーバーへの接続に失敗しました';
        }

        this.el.loginBtn.disabled = false;
        this.el.loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> ログイン';
    }

    async doRegister() {
        const name = this.el.registerName.value.trim();
        const password = this.el.registerPassword.value.trim();
        this.el.registerError.textContent = '';

        if (!name) { this.el.registerError.textContent = '名前を入力してください'; return; }
        if (!password || password.length < 4) { this.el.registerError.textContent = 'パスワードは4文字以上で入力してください'; return; }
        if (!/^[a-zA-Z0-9]+$/.test(password)) { this.el.registerError.textContent = 'パスワードは半角英数字のみです'; return; }

        this.el.registerBtn.disabled = true;
        this.el.registerBtn.textContent = '登録中...';

        try {
            const res = await GasAPI.register(name, password);
            if (res.ok) {
                // 登録後にそのままログイン
                const loginRes = await GasAPI.login(name, password, '');
                if (loginRes.ok) {
                    this.token = loginRes.token;
                    this.myName = loginRes.name;
                    localStorage.setItem('svc_token', this.token);
                    localStorage.setItem('svc_name', this.myName);
                    this.enterMainScreen();
                } else {
                    // 登録成功・ログイン失敗 → ログインタブへ
                    document.querySelector('[data-tab="login"]').click();
                    this.el.loginName.value = name;
                }
            } else {
                this.el.registerError.textContent = res.error || '登録に失敗しました';
            }
        } catch (e) {
            this.el.registerError.textContent = 'サーバーへの接続に失敗しました';
        }

        this.el.registerBtn.disabled = false;
        this.el.registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> アカウントを作成';
    }

    // =====================================================
    // メイン画面への遷移
    // =====================================================
    async enterMainScreen() {
        this.el.authScreen.style.display = 'none';
        this.el.mainScreen.style.display = '';
        this.el.headerUserName.textContent = this.myName;
        this.el.localName.textContent = this.myName;

        this.updateStatus('初期化中...');

        try {
            await this.initializePeer();
            await this.setupLocalStream();
            this.isMediaReady = true;
            this.startHeartbeat();
            this.startPolling();
            await this.refreshOnlineList();
        } catch (e) {
            console.error('初期化エラー:', e);
            this.showNotification('エラー', '初期化に失敗しました: ' + e.message, 'error');
        }
    }

    // =====================================================
    // メイン画面イベント
    // =====================================================
    setupMainEvents() {
        // ログアウト
        this.el.logoutBtn.addEventListener('click', () => this.doLogout());

        // セキュリティパネルトグル
        this.el.securityToggleBtn.addEventListener('click', () => {
            this.el.securityPanel.classList.toggle('collapsed');
            this.el.securityToggleBtn.classList.toggle('active');
        });

        // コピーボタン
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.target);
                input.select();
                document.execCommand('copy');
                this.showNotification('成功', 'コピーしました', 'success');
            });
        });

        // 暗号化キー表示切り替え
        const visToggle = document.querySelector('.toggle-visibility-btn');
        if (visToggle) {
            visToggle.addEventListener('click', () => {
                this.isKeyVisible = !this.isKeyVisible;
                this.el.encryptionKey.type = this.isKeyVisible ? 'text' : 'password';
                visToggle.querySelector('i').className = this.isKeyVisible ? 'fas fa-eye' : 'fas fa-eye-slash';
            });
        }

        // リスト更新
        this.el.refreshListBtn.addEventListener('click', () => this.refreshOnlineList());

        // 通話制御
        this.el.disconnectButton.addEventListener('click', () => {
            if (this.isDisconnecting) return;
            this.disconnectedBySelf = true;
            // isDisconnecting はここでは立てない。disconnect()内で立てる。
            // sendDisconnectSignal中に相手イベントが来てもhandleRemoteDisconnect側でisDisconnectingを見るため、
            // sendDisconnectSignal完了後にdisconnect()を呼ぶことで二重実行を防ぐ。
            this.sendDisconnectSignal().then(() => {
                this.showDisconnectOverlay('通話を終了しました');
                this.disconnect();
            });
        });
        this.el.toggleMicButton.addEventListener('click', () => this.toggleAudio());
        this.el.toggleVideoButton.addEventListener('click', () => this.toggleVideo());
        this.el.volumeControlButton.addEventListener('click', () => this.toggleVolumeControl());
        this.el.volumeSlider.addEventListener('input', e => this.updateVolume(e.target.value));

        // 着信応答
        this.el.acceptCallBtn.addEventListener('click', () => this.acceptIncomingCall());
        this.el.rejectCallBtn.addEventListener('click', () => this.rejectIncomingCall());

        // 発信キャンセル
        this.el.cancelCallBtn.addEventListener('click', () => this.cancelOutgoingCall());

        // 通知モーダル閉じる
        document.querySelector('.modal-close').addEventListener('click', () => {
            this.el.notificationModal.classList.remove('visible');
        });

        // 音量コントロール外クリックで閉じる
        document.addEventListener('click', e => {
            if (this.el.volumeSliderContainer &&
                !this.el.volumeSliderContainer.contains(e.target) &&
                !this.el.volumeControlButton.contains(e.target)) {
                this.isVolumeControlVisible = false;
                this.el.volumeSliderContainer.classList.remove('visible');
            }
        });

        // Shift×3ショートカット
        const STORAGE_KEY = 'svc_shortcut_url';
        const DEFAULT_URL = 'https://www.google.com';
        const savedUrl = localStorage.getItem(STORAGE_KEY);
        if (savedUrl && this.el.shiftShortcutUrl) this.el.shiftShortcutUrl.value = savedUrl;

        if (this.el.saveShortcutBtn) {
            this.el.saveShortcutBtn.addEventListener('click', () => {
                const url = this.el.shiftShortcutUrl.value.trim();
                if (url) {
                    localStorage.setItem(STORAGE_KEY, url);
                    this.el.shortcutSavedMsg.classList.add('visible');
                    setTimeout(() => this.el.shortcutSavedMsg.classList.remove('visible'), 1500);
                }
            });
        }

        let shiftTimes = [];
        document.addEventListener('keydown', e => {
            if (e.key !== 'Shift') return;
            const now = Date.now();
            shiftTimes.push(now);
            shiftTimes = shiftTimes.filter(t => now - t < 1000);
            if (shiftTimes.length >= 3) {
                shiftTimes = [];
                const url = localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;
                const w = window.screen.availWidth;
                const h = window.screen.availHeight;
                window.open(url, '_blank', `width=${w},height=${h},left=0,top=0,noopener`);
                this.updateVolume(0);
                if (this.el.volumeSlider) this.el.volumeSlider.value = 0;
            }
        });
    }

    doLogout() {
        // ① 先にlocalStorageとトークンをクリアして画面を即切替
        const tokenToInvalidate = this.token;
        this.clearLocalSession();

        // ② 画面を即座に切替
        this.el.mainScreen.style.display = 'none';
        this.el.authScreen.style.display = '';
        this.el.loginName.value = '';
        this.el.loginPassword.value = '';

        // ③ クリーンアップ・GASログアウトはバックグラウンドで非同期処理
        this.stopHeartbeat();
        this.stopPolling();
        if (this._qualityInterval) {
            clearInterval(this._qualityInterval);
            this._qualityInterval = null;
        }
        this.cleanup().catch(() => { });
        if (tokenToInvalidate) {
            GasAPI.logout(tokenToInvalidate).catch(() => { });
        }
    }

    // =====================================================
    // PeerJS初期化
    // =====================================================
    async initializePeer() {
        this.encryptionKey = await CryptoUtil.generateKey();
        const exportedKey = await CryptoUtil.exportKey(this.encryptionKey);
        this.el.encryptionKey.value = exportedKey;

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.google.com:19302' },
                    ],
                    iceTransportPolicy: 'all',
                    iceCandidatePoolSize: 10
                },
                secure: true,
                debug: 1
            });

            this.peer.on('open', async (id) => {
                this.el.localPeerId.value = id;
                this.updateStatus('オンライン');
                // ピアIDをGASに登録
                if (this.token) {
                    try { await GasAPI.heartbeat(this.token, id); } catch (_) { }
                }
                resolve(id);
            });

            this.peer.on('call', async call => {
                // 着信：acceptIncomingCall()後に発信者からcallが来る
                if (!this.currentCall) {
                    call.answer(this.localStream);
                    this.handleCall(call);
                    // callTargetNameはacceptIncomingCall()でセット済み
                    this.el.remoteName.textContent = this.callTargetName || '相手';
                    this.el.videoGrid.style.display = '';
                    this.el.waitingState.style.display = 'none';
                    this.el.callControls.style.display = '';
                    this.showUserListSection(false); // 通話中はリストを隠す
                    this.updateStatus('通話中');
                }
            });

            this.peer.on('connection', conn => {
                if (!this.dataConnection) {
                    this.dataConnection = conn;
                    this.setupDataConnection();
                }
            });

            this.peer.on('error', err => {
                reject(err);
            });

            this.peer.on('disconnected', () => {
                this.updateStatus('再接続中...', true);
                setTimeout(() => { if (this.peer) this.peer.reconnect(); }, 3000);
            });
        });
    }

    // =====================================================
    // ローカルストリーム
    // =====================================================
    async setupLocalStream() {
        this.updateStatus('カメラ/マイク準備中...');
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.el.localVideo.srcObject = this.localStream;
        this.updateStatus('オンライン');
    }

    // =====================================================
    // オンラインユーザーリスト
    // =====================================================
    async refreshOnlineList() {
        const icon = this.el.refreshListBtn.querySelector('i');
        icon.classList.add('fa-spin');

        try {
            const res = await GasAPI.onlineList(this.token);
            if (res.ok) {
                this.renderUserList(res.users);
            } else if (res.error === 'セッションが無効です') {
                this.doLogout();
            }
        } catch (e) {
            console.warn('リスト更新失敗:', e);
        }

        icon.classList.remove('fa-spin');
    }

    renderUserList(users) {
        const list = this.el.userList;
        list.innerHTML = '';

        if (!users || users.length === 0) {
            list.innerHTML = `
                <div class="user-list-empty">
                    <i class="fas fa-user-slash"></i>
                    <p>オンラインのユーザーがいません</p>
                </div>`;
            return;
        }

        users.forEach(user => {
            const item = document.createElement('div');
            item.className = 'user-item';
            item.innerHTML = `
                <div class="user-item-info">
                    <div class="user-avatar">${user.name.charAt(0).toUpperCase()}</div>
                    <span class="user-item-name">${this.escapeHtml(user.name)}</span>
                    <span class="user-online-dot"></span>
                </div>
                <button class="call-user-btn" data-name="${this.escapeHtml(user.name)}" data-peer="${this.escapeHtml(user.peer_id)}">
                    <i class="fas fa-phone"></i>
                    通話
                </button>`;
            item.querySelector('.call-user-btn').addEventListener('click', () => {
                this.startOutgoingCall(user.name, user.peer_id);
            });
            list.appendChild(item);
        });
    }

    escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // =====================================================
    // ハートビート（10秒ごと）
    // =====================================================
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(async () => {
            if (!this.token) return;
            const peerId = this.peer?.id || '';
            try {
                const res = await GasAPI.heartbeat(this.token, peerId);
                if (!res.ok) this.doLogout();
            } catch (_) { }
        }, 10000); // 10秒ごと（GAS側タイムアウト90秒に対して十分な余裕）
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // =====================================================
    // シグナルポーリング（2秒ごと）
    // =====================================================
    startPolling() {
        this.stopPolling();
        this._signalPollCount = 0;
        this.pollingInterval = setInterval(() => this.pollSignals(), 2000);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async pollSignals() {
        if (!this.token) return;
        try {
            const res = await GasAPI.getSignals(this.token);
            if (!res.ok) return;

            for (const signal of res.signals) {
                await this.handleSignal(signal);
                await GasAPI.ackSignal(this.token, signal.id);
            }

            // オンラインリストは5回に1回（約10秒ごと）更新
            this._signalPollCount = (this._signalPollCount || 0) + 1;
            if (this._signalPollCount >= 5) {
                this._signalPollCount = 0;
                // 通話中はリスト更新不要
                if (!this.currentCall) {
                    await this.refreshOnlineList();
                }
            }
        } catch (e) {
            console.warn('ポーリングエラー:', e);
        }
    }

    async handleSignal(signal) {
        console.log('[シグナル受信]', signal);
        switch (signal.type) {
            case 'call_request':
                // 通話中は自動拒否
                if (this.currentCall) {
                    await GasAPI.sendSignal(this.token, signal.from, 'call_reject', '通話中');
                    return;
                }
                this.showIncomingCall(signal);
                break;

            case 'call_accept':
                // 発信側：相手が応答した → WebRTC接続開始
                this.el.callingModal.classList.remove('visible');
                clearTimeout(this._callTimeout);
                console.log('[call_accept] 相手ピアID:', signal.signal_data);
                this.initiateWebRTCCall(signal.signal_data);
                break;

            case 'call_reject':
                clearTimeout(this._callTimeout);
                this.el.callingModal.classList.remove('visible');
                this.callTargetName = null;
                this.showNotification('通知', `${signal.from} は通話を拒否しました`, 'warning');
                break;

            case 'call_end':
                if (!this.isDisconnecting && this.currentCall) {
                    this.handleRemoteDisconnect(`${signal.from} が通話を終了しました`);
                }
                break;
        }
    }

    // =====================================================
    // 発信
    // =====================================================
    async startOutgoingCall(targetName, targetPeerId) {
        if (this.currentCall) {
            this.showNotification('通知', '現在通話中です', 'warning');
            return;
        }
        if (!targetPeerId) {
            this.showNotification('エラー', '相手のピアIDが取得できませんでした。リストを更新してください。', 'error');
            return;
        }
        // 自分のピアIDが確定していない場合はエラー
        if (!this.peer || !this.peer.id) {
            this.showNotification('エラー', '接続の準備が完了していません。しばらく待ってから再試行してください。', 'error');
            return;
        }

        this.callTargetName = targetName;
        this._targetPeerId = targetPeerId;
        this.el.callingTargetName.textContent = targetName;
        this.el.callingModal.classList.add('visible');

        try {
            // 自分のピアIDをsignal_dataとして送信
            const myPeerId = this.peer.id;
            console.log('[発信] to:', targetName, 'myPeerId:', myPeerId);
            const res = await GasAPI.sendSignal(this.token, targetName, 'call_request', myPeerId);
            if (!res.ok) {
                this.el.callingModal.classList.remove('visible');
                this.showNotification('エラー', '通話申請の送信に失敗しました: ' + (res.error || ''), 'error');
                return;
            }
        } catch (e) {
            this.el.callingModal.classList.remove('visible');
            this.showNotification('エラー', '通話申請の送信に失敗しました', 'error');
            return;
        }

        // 30秒でタイムアウト
        this._callTimeout = setTimeout(() => {
            if (this.el.callingModal.classList.contains('visible')) {
                this.el.callingModal.classList.remove('visible');
                this.callTargetName = null;
                this.showNotification('通知', '通話申請がタイムアウトしました', 'warning');
            }
        }, 30000);
    }

    async cancelOutgoingCall() {
        clearTimeout(this._callTimeout);
        this.el.callingModal.classList.remove('visible');
        if (this.callTargetName) {
            try {
                await GasAPI.sendSignal(this.token, this.callTargetName, 'call_reject', 'キャンセル');
            } catch (_) { }
        }
        this.callTargetName = null;
    }

    // 相手が承認したら実際にWebRTC接続
    initiateWebRTCCall(remotePeerId) {
        if (!remotePeerId || !this.localStream) return;

        this.el.remoteName.textContent = this.callTargetName || '相手';
        this.el.videoGrid.style.display = '';
        this.el.waitingState.style.display = 'none';
        this.el.callControls.style.display = '';
        this.showUserListSection(false); // 通話中はリストを隠す

        this.dataConnection = this.peer.connect(remotePeerId);
        this.setupDataConnection();

        const call = this.peer.call(remotePeerId, this.localStream);
        this.handleCall(call);
    }

    // =====================================================
    // 着信
    // =====================================================
    showIncomingCall(signal) {
        this.pendingSignal = signal;
        this.el.incomingCallerName.textContent = signal.from;
        this.el.incomingCallModal.classList.add('visible');

        // 30秒で自動拒否
        this._incomingTimeout = setTimeout(() => {
            if (this.el.incomingCallModal.classList.contains('visible')) {
                this.rejectIncomingCall();
            }
        }, 30000);
    }

    async acceptIncomingCall() {
        clearTimeout(this._incomingTimeout);
        this.el.incomingCallModal.classList.remove('visible');

        if (!this.pendingSignal) return;
        const signal = this.pendingSignal;
        this.pendingSignal = null;

        // call_requestのsignal_dataが発信者のピアID
        console.log('[着信承認] 発信者ピアID:', signal.signal_data, '発信者名:', signal.from);

        this.callTargetName = signal.from;
        this.el.remoteName.textContent = signal.from;
        // UI表示はpeer.on('call')のanswerタイミングで行う（発信者がcallを送ってくるまで待つ）

        // 自分のピアIDを相手に返す（承認シグナル）
        try {
            await GasAPI.sendSignal(this.token, signal.from, 'call_accept', this.peer.id);
        } catch (e) {
            this.showNotification('エラー', '応答シグナルの送信に失敗しました', 'error');
            return;
        }

        // 着信側はpeer.on('call')で自動的にanswerされるため、ここでは何もしない
        // （発信者がcall_acceptを受け取った後にWebRTC接続を開始する）
        console.log('[着信承認完了] 発信者からのWebRTC着信を待機中...');
    }

    async rejectIncomingCall() {
        clearTimeout(this._incomingTimeout);
        this.el.incomingCallModal.classList.remove('visible');

        if (!this.pendingSignal) return;
        const signal = this.pendingSignal;
        this.pendingSignal = null;

        try {
            await GasAPI.sendSignal(this.token, signal.from, 'call_reject', '拒否');
        } catch (_) { }
    }

    // =====================================================
    // WebRTC通話処理（既存コードを踏襲）
    // =====================================================
    handleCall(call) {
        this.currentCall = call;
        this._remoteDisconnectHandled = false; // 新しい通話開始 → フラグをリセット

        call.on('stream', stream => {
            this.el.remoteVideo.srcObject = stream;
            this.setupAudioBoost(stream);
            this.updateStatus('通話中');
            this.startConnectionQualityMonitoring();
        });

        call.on('close', () => {
            // isDisconnecting中（自分側のcleanupが原因のclose）は無視
            if (this.isDisconnecting) return;
            this.handleRemoteDisconnect('相手が通話を終了しました');
        });

        call.peerConnection.oniceconnectionstatechange = () => {
            this.updateConnectionQuality(call.peerConnection.iceConnectionState);
        };
    }

    setupDataConnection() {
        this.dataConnection.on('open', () => {
            this.updateStatus('通話中');
        });

        this.dataConnection.on('data', async data => {
            if (data && data.type === 'DISCONNECT_SIGNAL') {
                this.handleRemoteDisconnect('相手が通話を終了しました');
                return;
            }
            try {
                const decrypted = await CryptoUtil.decrypt(this.encryptionKey, data.iv, data.encryptedData);
                this.handleReceivedData(JSON.parse(new TextDecoder().decode(decrypted)));
            } catch (_) { }
        });

        this.dataConnection.on('close', () => {
            // isDisconnecting中（自分側のcleanupが原因のclose）は無視
            if (this.isDisconnecting) return;
            this.handleRemoteDisconnect('相手が通話を終了しました');
        });
    }

    // 相手側の切断を一元処理（二重発火防止付き）
    handleRemoteDisconnect(reason) {
        if (this.isDisconnecting) return; // すでに処理中なら無視
        if (this._remoteDisconnectHandled) return; // 複数イベント源からの重複発火を防止
        this._remoteDisconnectHandled = true;
        this.showDisconnectOverlay(reason);
        this.disconnect();
    }

    async sendDisconnectSignal() {
        // WebRTCデータチャネル経由
        if (this.dataConnection && this.dataConnection.open !== false) {
            try {
                this.dataConnection.send({ type: 'DISCONNECT_SIGNAL' });
                await new Promise(r => setTimeout(r, 150));
            } catch (_) { }
        }
        // GASシグナル経由（バックアップ）
        if (this.token && this.el.remoteName.textContent) {
            try {
                await GasAPI.sendSignal(this.token, this.el.remoteName.textContent, 'call_end', '');
            } catch (_) { }
        }
    }

    async disconnect() {
        if (this.isDisconnecting) return; // 二重実行防止
        this.isDisconnecting = true;
        // _remoteDisconnectHandled はここではリセットしない。
        // 次の通話開始時（handleCall）にリセットする。

        // 接続品質モニタリングを停止
        if (this._qualityInterval) {
            clearInterval(this._qualityInterval);
            this._qualityInterval = null;
        }

        await this.cleanup();

        // UI をリストに戻す（Bug 3: ここを確実に実行する）
        this.el.videoGrid.style.display = 'none';
        this.el.waitingState.style.display = '';
        this.el.callControls.style.display = 'none';
        this.showUserListSection(true);

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
            this.gainNode = null;
        }
        this.el.remoteVideo.muted = false;
        this.isVolumeControlVisible = false;
        if (this.el.volumeSliderContainer) this.el.volumeSliderContainer.classList.remove('visible');
        if (this.el.volumeSlider) this.el.volumeSlider.value = 100;
        this.updateStatus('オンライン');

        this.disconnectedBySelf = false;
        this.isDisconnecting = false;
        this.callTargetName = null;

        // PeerJSを再初期化してオンライン状態に戻る
        try {
            await this.initializePeer();
            await this.setupLocalStream();
            this.isMediaReady = true;
        } catch (e) {
            console.warn('再初期化失敗:', e);
        }

        await this.refreshOnlineList();
    }

    // オンラインユーザーリストの表示/非表示
    showUserListSection(visible) {
        const section = document.querySelector('.user-list-section') || this.el.userList?.closest('section') || this.el.userList?.parentElement;
        if (section) section.style.display = visible ? '' : 'none';
    }

    async cleanup() {
        // イベントリスナーが再発火しないよう先にnullで参照を切る
        const call = this.currentCall;
        const dc = this.dataConnection;
        const peer = this.peer;
        const stream = this.localStream;

        this.currentCall = null;
        this.dataConnection = null;
        this.peer = null;
        this.localStream = null;

        if (stream) stream.getTracks().forEach(t => t.stop());
        if (call) { try { call.close(); } catch (_) { } }
        if (dc) { try { dc.close(); } catch (_) { } }
        if (peer) { try { peer.destroy(); } catch (_) { } }

        if (this.el.remoteVideo) this.el.remoteVideo.srcObject = null;
        if (this.el.localVideo) this.el.localVideo.srcObject = null;
    }

    handleReceivedData(data) {
        console.log('Received:', data);
    }

    // =====================================================
    // 音声・映像制御
    // =====================================================
    toggleAudio() {
        this.isAudioEnabled = !this.isAudioEnabled;
        if (this.localStream) this.localStream.getAudioTracks().forEach(t => t.enabled = this.isAudioEnabled);
        this.el.toggleMicButton.classList.toggle('active', !this.isAudioEnabled);
        this.el.toggleMicButton.querySelector('i').className = this.isAudioEnabled ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    }

    toggleVideo() {
        this.isVideoEnabled = !this.isVideoEnabled;
        if (this.localStream) this.localStream.getVideoTracks().forEach(t => t.enabled = this.isVideoEnabled);
        this.el.toggleVideoButton.classList.toggle('active', !this.isVideoEnabled);
        this.el.toggleVideoButton.querySelector('i').className = this.isVideoEnabled ? 'fas fa-video' : 'fas fa-video-slash';
    }

    toggleVolumeControl() {
        this.isVolumeControlVisible = !this.isVolumeControlVisible;
        this.el.volumeSliderContainer.classList.toggle('visible', this.isVolumeControlVisible);
    }

    setupAudioBoost(stream) {
        try {
            if (this.audioContext) this.audioContext.close();
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioSource = this.audioContext.createMediaStreamSource(stream);
            this.gainNode = this.audioContext.createGain();
            this.audioSource.connect(this.gainNode);
            this.gainNode.connect(this.audioContext.destination);
            this.gainNode.gain.value = this.currentVolume / 100;
            this.el.remoteVideo.muted = true;
        } catch (e) { console.warn('WebAudio初期化失敗:', e); }
    }

    updateVolume(value) {
        this.currentVolume = parseInt(value);
        const gain = this.currentVolume / 100;
        if (this.gainNode) this.gainNode.gain.value = gain;
        else this.el.remoteVideo.volume = Math.min(gain, 1);

        const icon = this.el.volumeControlButton.querySelector('i');
        if (value == 0) icon.className = 'fas fa-volume-mute';
        else if (value < 50) icon.className = 'fas fa-volume-down';
        else icon.className = 'fas fa-volume-up';

        const pct = (this.currentVolume / 300) * 100;
        const overBoost = this.currentVolume > 100;
        let bg;
        if (!overBoost) {
            bg = `linear-gradient(to right, rgba(255,255,255,0.8) ${pct}%, rgba(255,255,255,0.2) ${pct}%)`;
        } else {
            const normalPct = (100 / 300) * 100;
            bg = `linear-gradient(to right, rgba(255,255,255,0.8) ${normalPct}%, #f59e0b ${normalPct}%, #f59e0b ${pct}%, rgba(255,255,255,0.2) ${pct}%)`;
        }
        this.el.volumeSlider.style.background = bg;
        this.el.volumeSlider.classList.toggle('boosted', overBoost);
        if (this.el.volumeValue) this.el.volumeValue.textContent = this.currentVolume;
        if (this.el.boostBadge) this.el.boostBadge.classList.toggle('visible', overBoost);
    }

    // =====================================================
    // 接続品質モニタリング
    // =====================================================
    startConnectionQualityMonitoring() {
        // 既存のインターバルをクリア（重複防止）
        if (this._qualityInterval) {
            clearInterval(this._qualityInterval);
        }
        this._qualityInterval = setInterval(() => {
            if (!this.currentCall?.peerConnection) {
                clearInterval(this._qualityInterval);
                this._qualityInterval = null;
                return;
            }
            this.currentCall.peerConnection.getStats().then(stats => {
                stats.forEach(r => {
                    if (r.type === 'candidate-pair' && r.state === 'succeeded') {
                        this.el.connectionQuality.textContent = this.calcQuality(r);
                    }
                });
            });
        }, 2000); // 2秒ごと（1秒は過剰）
    }

    calcQuality(stats) {
        if (stats.availableOutgoingBitrate) {
            const bps = stats.availableOutgoingBitrate / 1000000;
            if (bps > 2) return '良好';
            if (bps > 1) return '普通';
            return '不安定';
        }
        return '計測中...';
    }

    updateConnectionQuality(state) {
        const map = { new: '接続確認中...', checking: '接続確認中...', connected: '良好', completed: '安定', disconnected: '切断', failed: '接続失敗' };
        this.el.connectionQuality.textContent = map[state] || '不明';
    }

    // =====================================================
    // UI ヘルパー
    // =====================================================
    updateStatus(message, isError = false) {
        if (this.el.connectionStatus) this.el.connectionStatus.textContent = message;
        if (this.el.statusIndicator) this.el.statusIndicator.classList.toggle('connected', !isError && message === 'オンライン' || message === '通話中');
    }

    showNotification(title, message, type = 'info') {
        const modal = this.el.notificationModal;
        const msgEl = modal.querySelector('.modal-message');
        const iconEl = modal.querySelector('.modal-icon');
        msgEl.textContent = message;
        iconEl.className = 'modal-icon fas';
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
        iconEl.classList.add(icons[type] || 'fa-info-circle');
        const colors = { success: 'var(--success-color)', error: 'var(--danger-color)', warning: 'var(--warning-color)', info: 'var(--primary-color)' };
        iconEl.style.color = colors[type] || 'var(--primary-color)';
        modal.classList.add('visible');
    }

    showDisconnectOverlay(reason = '通話が終了しました') {
        const existing = document.getElementById('disconnectOverlay');
        if (existing) existing.remove();
        const overlay = document.createElement('div');
        overlay.id = 'disconnectOverlay';
        overlay.className = 'disconnect-overlay';
        overlay.innerHTML = `
            <div class="disconnect-overlay-content">
                <div class="disconnect-icon"><i class="fas fa-phone-slash"></i></div>
                <p class="disconnect-reason">${this.escapeHtml(reason)}</p>
                <p class="disconnect-sub">接続が切断されました</p>
                <button class="disconnect-close-btn" onclick="document.getElementById('disconnectOverlay').remove()">閉じる</button>
            </div>`;
        document.body.appendChild(overlay);
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 400);
            }
        }, 5000);
    }

    onBeforeUnload() {
        this.isDisconnecting = true; // ページ離脱 → 以降のイベントをすべて無視
        if (this.dataConnection?.open !== false) {
            try { this.dataConnection.send({ type: 'DISCONNECT_SIGNAL' }); } catch (_) { }
        }
        if (this.token) {
            // sendBeaconを使うとページ離脱時でも確実にリクエストが送られる
            try {
                const url = new URL(GAS_URL);
                url.searchParams.set('action', 'logout');
                url.searchParams.set('token', this.token);
                navigator.sendBeacon(url.toString());
            } catch (_) {
                try { GasAPI.logout(this.token); } catch (__) { }
            }
        }
        this.cleanup();
    }
}

// =====================================================
// エントリポイント
// =====================================================
window.addEventListener('DOMContentLoaded', () => {
    new SecureVideoChat();
});
