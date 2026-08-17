# نشر مساعد التسجيل على VPS Linux باستخدام Coolify

## القرار المعماري

- VPS واحد فقط يكفي: Coolify والتطبيق على نفس السيرفر.
- التطبيق Container واحد يشغّل Node.js وChromium وشاشة Linux افتراضية وnoVNC وNginx.
- طلبات `Signin.aspx` و`POST` تخرج من شبكة وعنوان IP الخاص بالـVPS.
- جهازك يستقبل الداشبورد وصورة المتصفح البعيد فقط.
- لا توجد قاعدة بيانات ولا تخزين دائم لبيانات الدخول.
- Browserless غير مطلوب في هذه النسخة؛ noVNC يضمن استمرار الصفحة التالية بشكل تفاعلي.

المواصفات الموصى بها: Ubuntu حديث، 2 vCPU، و4 GB RAM. يمكن أن يعمل على 2 GB لكن Coolify وChromium قد يستهلكان الذاكرة تحت الضغط. اترك مساحة تخزين لا تقل عن 10 GB لبناء صورة Chromium.

## 1. قبل الرفع

1. غيّر أي Token أو كلمة مرور سبق إرسالها في محادثة أو مشاركتها مع شخص آخر.
2. ضع هذا المجلد في Git repository خاص. لا تضع ملفات `.env` أو كلمات مرور في Git.
3. أنشئ DNS Record من النوع `A` مثل `register.example.com` يشير إلى IP الـVPS.
4. تأكد أن Coolify يعمل على السيرفر وأن Proxy الخاص به سليم.

## 2. إنشاء التطبيق في Coolify

1. افتح Coolify واختر **Projects**.
2. أنشئ Project أو افتح Project موجود، ثم Environment مثل `production`.
3. اختر **New Resource** ثم Git Repository.
4. اختر الـrepository الخاص بالمشروع.
5. اختر Build Pack من نوع **Docker Compose**.
6. اجعل مسار الملف `/docker-compose.yml` إن طلب Coolify ذلك.
7. بعد قراءة Compose سيظهر Service باسم `nursing-register`.

## 3. Environment Variables

أضف القيم التالية من شاشة Environment Variables داخل Coolify:

```text
APP_USERNAME=admin
APP_PASSWORD=ضع-هنا-كلمة-مرور-عشوائية-قوية-من-20-إلى-64-حرفًا
REQUEST_TIMEOUT_MS=400000
MIN_POST_INTERVAL_MS=30000
UPSTREAM_URL=http://mhealthmobasn.cu.edu.eg/
```

قواعد مهمة:

- `APP_PASSWORD` مطلوب، ولا يعمل الـContainer إذا كان أقل من 16 أو أكثر من 72 حرفًا.
- لإنشاء قيمة آمنة وسهلة النسخ على Linux استخدم `openssl rand -hex 24` ثم ضع الناتج كقيمة `APP_PASSWORD`.
- لا تجعل `APP_PASSWORD` Build Variable؛ هي Runtime secret فقط.
- لا تستخدم نفس كلمة مرور Coolify أو VPS.
- لا تضف `PUPPETEER_BROWSER_WSENDPOINT`؛ التطبيق لا يستخدم Browserless حاليًا.

## 4. الدومين وHTTPS

داخل Service `nursing-register` ضع الدومين بالشكل التالي:

```text
https://register.example.com:3000
```

الرقم `3000` يخبر Proxy الخاص بـCoolify بالمنفذ الداخلي للحاوية، بينما المستخدم يفتح HTTPS العادي بدون كتابة المنفذ. فعّل Generate/Let's Encrypt Certificate إن لم يفعّله Coolify تلقائيًا.

لا تضف Host Port Mapping، ولا تفتح المنافذ `5900` أو `6080` في Firewall. هذان المنفذان داخليان فقط، وnoVNC يصل إليهما من خلال Nginx المحمي.

## 5. النشر

1. اضغط **Deploy**.
2. أول Build قد يستغرق عدة دقائق لأنه ينزّل Chromium واعتماداته.
3. انتظر حتى تصبح حالة Healthcheck سليمة.
4. افتح الدومين؛ سيطلب المتصفح `APP_USERNAME` و`APP_PASSWORD`.
5. إذا ظهر `502`، راجع Logs وتأكد أن Service domain يشير إلى port `3000`.

## 6. الاستخدام بعد النشر

1. افتح الداشبورد من الدومين عبر HTTPS.
2. اضغط **تجهيز جلسة**.
3. أدخل رقم الخريج والرقم القومي والكابتشا في الداشبورد.
4. اضغط **إرسال محاولة واحدة**.
5. راقب بطاقة آخر POST؛ `HTTP 200` مع رسالة الضغط يظهر كفشل دخول، وليس نجاحًا.
6. اضغط **إظهار المتصفح** لرؤية Chromium الموجود على الـVPS.
7. عند نجاح الدخول يفتح البرنامج إطار المتصفح تلقائيًا، وتكمل صفحة الرغبات بنفس Session.

## 7. التحديث وإعادة التشغيل

- بعد Push جديد إلى Git استخدم **Redeploy** من Coolify.
- إعادة التشغيل أو Redeploy تغلق Chromium وتمسح Session الحالية؛ لا تنشر تحديثًا أثناء POST Pending.
- بيانات الرقمين الاختيارية موجودة في Local Storage على جهازك، وليست في قاعدة بيانات على VPS.

## 8. فحص المشاكل

- `Unhealthy`: افتح Container Logs وابحث عن فشل Xvfb أو Nginx أو Chromium.
- صفحة الداشبورد تعمل لكن المتصفح أسود: انتظر ثوانٍ ثم أخفِ وأظهر الإطار؛ راجع `x11vnc` و`websockify` في Logs.
- Chrome لا يبدأ: تأكد أن الـVPS لديه RAM كافية وأن `/dev/shm` للحاوية يساوي 1 GB.
- WebSocket يفصل: تأكد أن الدومين يمر عبر Proxy الخاص بـCoolify وأنك لم تعرض port `6080` مباشرة.
- الموقع بطيء رغم VPS: هذا يعني غالبًا أن وقت المعالجة داخل سيرفر الجامعة هو الجزء الأكبر، وليس سرعة اتصال جهازك.
