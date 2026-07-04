# Code Index — AI Ассистент
> Обновлено: 2026-07-04 16:33

## server.js — API маршруты
```
  51:app.use(express.json({ limit: '20mb' }));
  52:app.use(express.static(path.join(__dirname, 'public')));
  72:app.get('/api/status', (req, res) => {
  77:app.post('/api/kie/check-key', async (req, res) => {
  92:app.get('/api/kie/balance', async (req, res) => {
  105:app.post('/api/kie/save-key', async (req, res) => {
  163:app.post('/api/kie/upload-image', async (req, res) => {
  178:app.post('/api/analyze-image', async (req, res) => {
  227:app.use('/vref-processed/', express.static(VREF_PROCESSED_DIR));
  281:app.post('/api/kie/upscale-image', async (req, res) => {
  299:app.post('/api/kie/multiangle-image', async (req, res) => {
  388:app.post('/api/enhance-prompt', async (req, res) => {
  463:app.get('/api/kie/logs', async (req, res) => {
  505:app.post('/api/videogen', async (req, res) => {
  586:app.get('/api/videogen/status/:taskId', async (req, res) => {
  610:app.use('/cut-files', express.static(path.join(__dirname, 'data', 'cut-uploads')));
  644:app.post('/api/cut/upload', (req, res, next) => {
  664:app.post('/api/cut/transcribe', async (req, res) => {
  711:app.post('/api/cut/analyze', async (req, res) => {
  787:app.post('/api/cut/execute', async (req, res) => {
  858:app.get('/api/cut/projects/:projectId/probe', async (req, res) => {
  877:app.get('/api/cut/projects/:projectId/files', (req, res) => {
  893:app.get('/api/cut/projects/:projectId/clips', (req, res) => {
  913:app.delete('/api/cut/projects/:projectId/clips/:filename', (req, res) => {
  978:app.get('/api/era/articles', (req, res) => {
  984:app.get('/api/era/article/:slug', (req, res) => {
  994:app.post('/api/era/session', async (req, res) => {
  1014:app.post('/api/era/scrape-list', async (req, res) => {
  1059:app.post('/api/era/scrape-texts', async (req, res) => {
  1100:app.get('/api/era/progress', (req, res) => {
  1131:app.post('/api/era/chat', async (req, res) => {
  1220:app.post('/api/era/yt-list', async (req, res) => {
  1261:app.post('/api/era/yt-transcribe', async (req, res) => {
```

## public/index.html — JS функции
```
  1439:async function kieBalanceRefresh() {
  1455:function openPage(id) {
  1477:function toggleBlock(id) {
  1482:function updateCounts() {
  1495:function vprojLoad() {
  1498:function vprojSave(list) {
  1502:function vprojRender() {
  1523:function vprojCreate() {
  1535:function vprojSelect(id) {
  1550:function vprojDelete(id, e) {
  1566:function vprojStartRename(id) {
  1592:function vswitchTab(tab, btn) {
  1602:async function kieLogsLoad() {
  1624:function kieLogsFilter() {
  1690:function kieLogExpand(btn, taskId) {
  1760:function vgenSelectModel(model, btn) {
  1874:function vgenRenderResolutions(list, defaultRes) {
  1894:function vgenUpdateImageSections() {
  1917:function vrefKey() {
  1923:function vrefGetImages() {
  1927:function vrefSaveImages(arr) {
  1931:function vrefOpen() {
  1940:function vrefPickOpen(slot) {
  1952:function vrefClose() {
  1958:function vrefUpload(event) {
  1975:function vrefDelete(id) {
  1981:function vrefPick(img) {
  1987:function vrefRender() {
  2041:function vgenHistoryLoad() {
  2044:function vgenHistorySave(entry) {
  2051:function vgenHistoryDelete(idx) {
  2058:function vgenHistoryRender() {
  2072:function vgenHistoryRestore(idx) {
  2201:async function vgenEnhancePrompt() {
  2255:function vgenDurInput(slider) {
  2260:function vgenGetParam(name) {
  2269:function vgenReset() {
  2286:function vgenClearOutput() {
  2296:function vgenReadFile(file, slot) {
  2301:function vgenFileImage(event, slot) { if (event.target.files[0]) vgenReadFile(event.target.files[0], slot); }
  2302:function vgenDropImage(event, slot) {
  2308:function vgenSetImage(slot, dataUrl) {
  2323:function vgenClearImage(slot) {
  2340:async function vgenAnalyzeImage() {
  2378:async function vrefKieProcess(imgId, type) {
  2427:async function vgenUploadImage(base64) {
  2442:function vgenShowProgress(msg) {
  2463:function vgenAnimateProgress(pct) {
  2468:function vgenShowResult(url, credits, costTime) {
  2500:function vgenShowError(msg) {
  2513:async function vgenPoll(taskId, startTime, attempt) {
  2549:function vgenRestoreIfActive() {
  2564:async function vgenRun() {
  2663:  function getBlockType(el) {
  2671:  function savePosToStorage() {
  2684:  function loadPositions() {
  2706:  function initDrag(el) {
  2726:  function initList(list) {
  2745:  function getDragAfterElement(container, y) {
  2768:async function checkOpenAIKey(key) {
  2777:async function checkOpenRouterKey(key) {
  2786:async function checkKieKey(key) {
  2798:function setKeyStatus(id, state) {
  2809:function updateHeaderDot() {
  2825:async function runKeyChecks() {
  2844:function openApiSettings() {
  2863:function closeApiSettings() {
  2871:function toggleApiKeyVisibility(inputId) {
  2876:async function saveApiSettings() {
  2930:function cutProjLoad() {
  2933:function cutProjSave() {
  2936:function cutProjCreate() {
  2945:function cutProjSelect(id) {
  2981:function cutProjRename(id) {
  2991:function cutProjRender() {
  3007:function cutProjDelete(id) {
  3022:async function cutFilesLoad() {
  3057:function cutFilesUploadNew() {
  3061:async function cutFilesHandleNew(file) {
  3069:function cutFilesUseAsSource(url, filename) {
  3081:function cutSetFormat(fmt) {
  3091:async function cutSmartFormat() {
  3128:function cutSmartSetCrop(v) {
  3133:function cutSwitchTab(name, btn) {
  3140:function cutShowVideoInfo(name, dur, size) {
  3147:function cutFmtDur(s) {
  3152:function cutFmtSize(bytes) {
  3158:function cutHandleDrop(ev) {
  3164:function cutHandleFile(file) {
  3168:async function cutUploadVideo(file) {
  3204:async function cutTranscribe() {
  3241:async function cutAnalyze() {
  3287:function cutRenderCutsList(cuts) {
  3301:async function cutExecute() {
  3331:async function cutGalleryLoad() {
  3375:async function cutClipDelete(filename) {
  3392:function eraInit() {
  3402:function eraProgressStart() {
  3408:async function eraProgressPoll() {
  3435:function eraTab(name, btn) {
  3443:async function eraLoadArticles() {
  3465:function eraRenderArticles() {
  3484:async function eraScrapeList() {
  3498:async function eraScrapeTexts() {
  3512:async function eraSaveCookie() {
  3528:function eraYtRender() {
  3544:async function eraYtImport() {
  3559:async function eraYtTranscribeAll() {
  3584:function eraChatBubble(role, html) {
  3596:function eraEsc(s) {
  3600:async function eraChatSend() {
```

## public/index.html — Модальные окна (id)
```
  3648:<div id="modal-api-settings" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:none;align-items:center;justify-content:center;" onclick="if(event.target===this)closeApiSettings()">
  3718:<div id="modal-vref" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;">
```

## services/ — модули бэкенда

### services/make-api.js
```
  1:const NOT_AVAILABLE = new Error('Make.com integration is temporarily unavailable: services/make-api.js was lost and needs to be restored.');
  3:function unavailable() {
  7:module.exports = {
```

## scripts/ — вспомогательные скрипты
```
  scripts/backup.sh
  scripts/codemap.sh
  scripts/find-code.js
```
