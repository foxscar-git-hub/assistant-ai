# Code Index — AI Ассистент
> Обновлено: 2026-06-28 11:59

## server.js — API маршруты
```
  7:app.use(express.json());
  8:app.use(express.static(path.join(__dirname, 'public')));
  11:app.get('/api/status', (req, res) => {
```

## public/index.html — JS функции
```
  425:function openPage(id) {
  443:function toggleBlock(id) {
  448:function updateCounts() {
  462:  function getBlockType(el) {
  470:  function savePosToStorage() {
  483:  function loadPositions() {
  505:  function initDrag(el) {
  525:  function initList(list) {
  544:  function getDragAfterElement(container, y) {
  565:function openApiSettings() {
  575:function closeApiSettings() {
  583:function toggleApiKeyVisibility(inputId) {
  587:function saveApiSettings() {
```

## public/index.html — Модальные окна (id)
```
  616:<div id="modal-api-settings" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:none;align-items:center;justify-content:center;" onclick="if(event.target===this)closeApiSettings()">
```

## services/ — модули бэкенда

## scripts/ — вспомогательные скрипты
```
  scripts/backup.sh
  scripts/codemap.sh
  scripts/find-code.js
```
