# تشغيل VARA في أي مكان — حاسوب، خادم VPS، Docker، جهاز CI

[English](../DEPLOYMENT.md) · **العربية**

`vara serve` يشغّل VARA كـ**خدمة بلا واجهة**: لا طرفية ولا متصفح على ذلك الجهاز. تفتح الواجهة من أي مكان (هاتف، لابتوب) ويعمل الوكيل على مجلد الخادم. هو نفس المضيف الذي يشغّله `vara ui` مع ما تحتاجه الخدمة: إعدادات من متغيرات البيئة، ورمز مالك يبقى بعد إعادة التشغيل، وسطور سجل تناسب journald وDocker، ونقطة فحص صحة، وإيقاف نظيف.

> **ما الذي تنشره فعلاً.** وكيل ينفّذ أوامر ويعدّل ملفات **على ذلك الجهاز**. اعتبر الجهاز (أو الحاوية) ملكاً للوكيل؛ أعطه مجلداً للمشروع لا قرصك كله، ولا تعرّضه للإنترنت إلا خلف TLS ورمز المالك.

| أين | كيف | الملفات |
| --- | --- | --- |
| حاسوبك | `vara serve` | — |
| خادم Linux (VPS) | خدمة systemd + وكيل عكسي بـTLS | `deploy/vara.service` و`deploy/vara.env.example` و`deploy/Caddyfile` أو `deploy/nginx.conf` |
| Docker | صورة + compose | `Dockerfile` و`deploy/docker-compose.yml` |
| جهاز CI | `vara run` (بلا واجهة، مهمة واحدة) أو `vara serve` قصير العمر | متغيرات البيئة أدناه |

## ١. خمس دقائق على جهازك

```bash
export OPENAI_API_KEY=sk-...          # أو شغّل `vara setup` مرة واحدة
vara serve
```

أول تشغيل يطبع **رابط دخول المالك لمرة واحدة**:

```
Owner login — shown ONCE. Open it (or keep the token in a password manager): only its hash is stored, so it cannot be shown again.
  http://127.0.0.1:7777/#token=…
```

افتحه. الرمز يسافر في الجزء بعد `#` من العنوان، وهذا الجزء لا يرسله المتصفح إلى أي خادم. أوقف بـ`Ctrl+C` (إيقاف نظيف: تُحفظ الجلسات).

## ٢. الإعدادات

الأعلام تتغلب على متغيرات البيئة، وكلاهما يتغلب على الافتراضي. المتغير **الفارغ** يعني «غير مضبوط».

| العلم | المتغير | الافتراضي | المعنى |
| --- | --- | --- | --- |
| `--port N` | `VARA_PORT` | `7777` | المنفذ (`0` = أي منفذ حر) |
| `--bind ADDR` | `VARA_BIND` | `127.0.0.1` | عنوان الاستماع. `--lan` = `0.0.0.0` |
| `--public-host NAME` | `VARA_PUBLIC_HOST` | — | اسم DNS الذي يخدمه الوكيل العكسي (بلا بروتوكول ولا منفذ). بدونه يجب أن يستعمل المتصفح عنوان IP على شبكة خاصة |
| `--cwd DIR` | `VARA_CWD` | المجلد الحالي | المجلد الذي يعمل فيه الوكيل |
| *(لا يوجد)* | `VARA_HOME` | `~/.vara` | كل ما يحفظه VARA: الإعداد والجلسات والخزنة وبصمة رمز المالك |
| `--token-file F` | `VARA_OWNER_TOKEN_FILE` | — | رمز مالك خاص بك من ملف (≥ 24 حرفاً) |
| `--token T` | `VARA_OWNER_TOKEN` | — | رمز مالك كقيمة (يظهر في `ps` إن كان علماً: فضّل الملف) |
| `--rotate-token` | — | — | استبدال الرمز المولَّد (الرمز القديم يتوقف) |
| `--trust-proxy` | `VARA_TRUST_PROXY=1` | مطفأ | عدّ محاولات الدخول الفاشلة لكل عميل حقيقي خلف الوكيل العكسي (§٥) |
| — | `VARA_DISABLE=team,gateways,tunnel,desktop,browser` | — | تعطيل ميزات لكامل المضيف: `team` (الضيوف وروابط الدعوة والجلسات المشتركة)، `gateways` (تيليجرام وديسكورد وسلاك)، `tunnel` (روابط المشاركة العامة)، `desktop` (التحكم بالحاسوب)، `browser` (أداة المتصفح). يرفضها المضيف (403) وتخفيها الواجهة. للاستضافة التي تحدد فيها الباقة ما يناله الشخص |
| — | `VARA_ALLOW_NO_PROVIDER=1` | مطفأ | يبدأ المضيف دون مفتاح نموذج (كما في `vara ui`): يضيف المالك مزوّداً من الإعدادات. للاستضافة التي يأتي فيها الشخص بمفتاحه بعد أول دخول |
| `--log MODE` | `VARA_LOG` | `text` (و`journal` تحت systemd) | `text` أو `json` (كائن في كل سطر) أو `journal` (بادئات أولوية syslog) |
| — | `VARA_NO_UPDATE_CHECK=1` | — | بلا طلب «يتوفر تحديث» اليومي |
| — | `OPENAI_API_KEY` و`ANTHROPIC_API_KEY`… | — | مفتاح النموذج (المتغير الذي يستعمله مزوّدك). أو خزّنه في الخزنة: `vara secret set NAME` |

التشغيل الذي لا يمكن أن ينجح يتوقف مع السبب (لا مفتاح نموذج، المنفذ مشغول، رمز قصير) بدل أن يعمل نصف مضبوط.

## ٣. رمز المالك

| ما تفعله | ما يحدث |
| --- | --- |
| لا شيء | أول تشغيل: يولّد VARA رمزاً عشوائياً بطول 256 بت، ويطبع رابط الدخول **مرة واحدة**، ويخزّن **بصمته SHA-256 فقط** في `$VARA_HOME/host/owner-token.sha256` (الصلاحية `0600`). التشغيلات التالية تقبله ولا تطبع شيئاً. |
| `--rotate-token` | رمز جديد يظهر مرة واحدة. القديم يتوقف فوراً. وهذه أيضاً طريقة استعادة رمز ضاع. |
| `--token-file` / `VARA_OWNER_TOKEN_FILE` | رمزك، يُقرأ عند البدء. لا يكتبه VARA في أي مكان ولا يطبعه. ملف يقرؤه مستخدمون آخرون يعطي تحذيراً (`chmod 600`). |

الضيوف لا يتأثرون: الدعوات والصلاحيات كما في بقية الوثائق (`vara invite` و`vara guests`).

## ٤. الإعدادات الآمنة الافتراضية

- يستمع على **127.0.0.1** ما لم تقل غير ذلك.
- للمضيف رمز مالك دائماً؛ لا يوجد وضع «بلا رمز».
- أي ربط غير محلي يطبع **تحذيراً** عند البدء: هو HTTP عادي، ضع TLS أمامه (§٥).
- اسم نطاق في ترويسة `Host` مرفوض ما لم يكن `--public-host` (حماية من DNS rebinding)؛ وعلى الشبكة الخاصة تُقبل عناوين IP الخاصة فقط.
- محاولات الدخول محدودة المعدل (10 إخفاقات كل 5 دقائق لكل عنوان).
- السجل لا يحوي عناوين الطلبات ولا نص الرسائل — فقط سطور البدء والإيقاف ورسائل الأخطاء الداخلية. الاستثناء الوحيد رابط المالك لمرة واحدة عند أول تشغيل (§٣)؛ والرمز الذي تقدّمه بنفسك لا يُطبع أبداً.
- الأسرار في الخزنة المشفرة (`vara secret set`)؛ والوكيل نفسه لا يستطيع قراءة مفتاح ولا رمز ولا الخزنة.

## ٥. خلف وكيل عكسي (TLS)

اربط VARA على `127.0.0.1`، ودع الوكيل ينهي TLS، وأخبر VARA باسمه العام:

```bash
VARA_BIND=127.0.0.1 VARA_PUBLIC_HOST=vara.example.com VARA_TRUST_PROXY=1 vara serve
```

ما **يجب** أن يفعله الوكيل (ملفا المثال يفعلانه):

1. **تمرير ترويسة `Host` كما هي** (`proxy_set_header Host $host`). VARA يقارنها بـ`VARA_PUBLIC_HOST`.
2. **عدم تخزين** البث الحي مؤقتاً. المحادثة تصل عبر Server-Sent Events والوكيل الذي يخزّن مؤقتاً يجعلها تتوقف. VARA يرسل أصلاً `X-Accel-Buffering: no`؛ اضبط أيضاً `proxy_buffering off` (nginx) أو `flush_interval -1` (Caddy)، وبلا مهلة قراءة للبث الهادئ.
3. **السماح بترقية WebSocket** (المعاينة الحية تمرّر websockets).
4. **استبدال `X-Forwarded-For`** بالعنوان الذي رآه. مع `VARA_TRUST_PROXY=1` يستعمل VARA آخر قيمة فيها لحد الدخول. بدون العلم يبدو كل زائر كأنه الوكيل فتستطيع محاولات غريب فاشلة أن تقفلك. لا تفعّل العلم إلا حين يكون الوكيل المدخل الوحيد (ربط `127.0.0.1` أو جدار ناري): وإلا يستطيع أي أحد تزوير الترويسة.

الملفات: [`deploy/Caddyfile`](../../deploy/Caddyfile) (HTTPS تلقائي، الأقصر) و[`deploy/nginx.conf`](../../deploy/nginx.conf) (مع `map` اللازمة لترويسة الترقية).

## ٦. خادم Linux مع systemd

```bash
sudo useradd --system --create-home --home-dir /var/lib/vara --shell /usr/sbin/nologin vara
sudo install -d -o vara -g vara -m 0750 /var/lib/vara/workspace
sudo cp deploy/vara.service /etc/systemd/system/vara.service
sudo install -d -m 0750 -o root -g vara /etc/vara
sudo cp deploy/vara.env.example /etc/vara/vara.env && sudo chmod 640 /etc/vara/vara.env
sudo editor /etc/vara/vara.env        # مفتاح النموذج، VARA_PUBLIC_HOST، VARA_TRUST_PROXY=1
sudo systemctl daemon-reload && sudo systemctl enable --now vara
journalctl -u vara -n 30              # رابط دخول المالك لمرة واحدة هنا
```

عدّل `ExecStart` إن لم يكن `vara` في `/usr/local/bin/vara`. الوحدة تعمل بمستخدم بلا صلاحيات مع `ProtectSystem=strict` و`NoNewPrivileges` و`/tmp` خاص وبلا وصول إلى المنزل و**`/var/lib/vara` فقط قابل للكتابة**: أضف مجلدات المشاريع التي يجب أن يغيّرها الوكيل إلى `ReadWritePaths=`. `systemctl stop vara` يرسل SIGTERM: تُحفظ الجلسات وتُغلق الاتصالات (حتى 30 ثانية قبل SIGKILL). سطور السجل تحمل أولويات `<6>`/`<4>`/`<3>` فيعرض `journalctl -p warning -u vara` المهم فقط.

الرابط لمرة واحدة موجود في السجل؛ لإبقائه خارجه استعمل `VARA_OWNER_TOKEN_FILE` برمز تولّده أنت (`openssl rand -base64 32 | sudo tee /etc/vara/owner-token` ثم `chmod 640` ومجموعة `vara`).

## ٧. Docker

```bash
cp deploy/vara.env.example deploy/.env        # اضبط OPENAI_API_KEY (أو متغير مزوّد آخر) وVARA_PUBLIC_HOST…
mkdir -p deploy/workspace && sudo chown 1000:1000 deploy/workspace
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml logs vara        # رابط المالك لمرة واحدة (سطور JSON)
```

تعمل الصورة بالمستخدم `node` غير الجذر، وتحفظ كل الحالة في الحجم `/data` (`VARA_HOME`) وتعمل على `/workspace`؛ وملف compose ينشر المنفذ على **127.0.0.1 فقط**، ويُسقط كل القدرات، ويجعل نظام الملفات الجذر للقراءة فقط، ويضيف `no-new-privileges`. للصورة **فحص صحة** (`GET /api/health`) فيعرض `docker ps` الحالة `healthy`. داخل الحاوية يجب أن يستمع المضيف على `0.0.0.0` (تضبطه الصورة)؛ وهذا آمن فقط لأن المنفذ المنشور محلي أو خلف وكيلك.

مفيد: `docker exec -it vara node dist/cli.js secret set OPENAI_API_KEY` (تخزين مفتاح في الخزنة) و`docker exec -it vara node dist/cli.js doctor --server`.

## ٨. جهاز CI

شكلان:

- **مهمة واحدة ثم الخروج** — بلا خادم: `OPENAI_API_KEY=… VARA_HOME=$RUNNER_TEMP/vara vara run "fix the failing test" --verify "npm test"` (انظر `vara --help`). اضبط `VARA_NO_UPDATE_CHECK=1`.
- **مضيف قصير العمر** لجلسة مراجعة: `vara serve --port 0 --cwd "$PWD" --token-file …` وافتحه عبر نفقك؛ وأوقفه بـSIGTERM.

استعمل `VARA_HOME` مؤقتاً ومفتاح API محدود الصلاحية، ولا تشارك مضيف جهاز CI علناً.

## ٩. حاسوب Windows يبقى يعمل

يعمل `vara serve` بالطريقة نفسها. لتشغيله عند الدخول أنشئ مهمة في Task Scheduler (شغّلها بحسابك، الإجراء `vara serve`، المشغّل «عند تسجيل الدخول»). مفتاح الخزنة محمي بحساب Windows (DPAPI) فيجب أن يعمل بذلك الحساب. وغلاف خدمة مثل NSSM يصلح أيضاً؛ لم يُجرَّب هنا.

## ١٠. افحص قبل أن تتركه يعمل

```bash
vara doctor --server
```

يفحص: قراءة الإعدادات، وقابلية الكتابة في مجلد البيانات، ووجود مجلد العمل، وأن المنفذ حر (أو من يشغله)، ومدى انكشاف المضيف، وإعداد رمز المالك، ومفتاح النموذج، والواجهة، وعند ضبط `--public-host` أن `https://<اسمك>/api/health` يجيب فعلاً عبر وكيلك. وداخل الحاوية يلتقط الخطأ الكلاسيكي (الاستماع على `127.0.0.1` داخلها). رمز الخروج 1 يعني أن شيئاً مطلوباً خاطئ.

## ١١. الترقية والنسخ الاحتياطي والإيقاف

- **النسخ الاحتياطي:** انسخ `VARA_HOME` والمضيف متوقف. على Linux مفتاح الخزنة ملف `0600` *داخله* فنسخة واحدة تعيد كل شيء؛ وعلى Windows/macOS المفتاح مرتبط بحساب المستخدم ولا ينتقل إلى جهاز آخر (أعد إدخال الأسرار هناك).
- **الترقية:** التثبيت المعبّأ: `vara update` ثم أعد تشغيل الخدمة. Docker: `git pull && docker compose … up -d --build`. حجم البيانات يبقى.
- **الإيقاف:** `SIGTERM`/`SIGINT` (systemd و`docker stop` و`Ctrl+C`): الوكلاء العاملون يُوقفون ويُحفظون، والرابط العام يُغلق، والاتصالات تُقطع. إشارة ثانية تخرج فوراً. وخطوة تعلق تُترك بعد 8 ثوانٍ ويكون رمز الخروج 1.

## ١٢. ما الذي جُرّب وما الذي لم يُجرَّب

مُختبر في هذا المستودع (`tests/daemon.test.ts` و`tests/system-privacy.test.ts`): قراءة الأعلام والمتغيرات وكل رفض مذكور أعلاه، ودورة حياة رمز المالك (توليد، حفظ كبصمة، إعادة تشغيل، تدوير، ملف مقدَّم)، وصيغ السجل، والإيقاف المرتب غير المتكرر، ومنطق doctor، وحد الدخول الواعي بالوكيل، وتشغيل حقيقي لـ`serveCommand` → `/api/health` → دخول المالك → إعادة تشغيل → إيقاف في عملية واحدة.

**لم يُشغَّل هنا — لا Docker ولا systemd ولا nginx ولا Caddy على جهاز البناء:** بناء `Dockerfile` وفحص صحته، و`docker-compose.yml`، و`vara.service` (أول ما يُشغَّل `systemd-analyze verify`)، وإعدادا الوكيلين كُتبت بعناية وروجعت لكنها لم تُنفَّذ. ومهمة Windows المجدولة وNSSM غير مجرَّبتين. جرّب كلاً على جهاز تجريبي أولاً وأبلغ بما ينكسر.
