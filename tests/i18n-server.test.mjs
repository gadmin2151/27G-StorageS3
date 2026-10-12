import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../web/i18n.js';
import { serverText } from '../web/i18n-server.js';

test('server messages follow the selected language without changing API codes or user values', () => {
  setLanguage('en');
  assert.equal(serverText('Неверный логин или пароль.'), 'Invalid username or password.');
  assert.equal(serverText('Для этого формата доступно скачивание без предпросмотра.'), 'This format can be downloaded but not previewed.');
  assert.equal(serverText('Узел Архив <disk> недоступен. Проверьте соединение и диск.'), 'Node Архив <disk> is unavailable. Check the connection and disk.');
  assert.equal(serverText('На узле русский-сервер занято не менее 90% диска.'), 'Node русский-сервер has at least 90% disk usage.');
  assert.equal(serverText('NoSuchKey'), 'NoSuchKey');
  assert.equal(serverText('Обзор/фото.png'), 'Обзор/фото.png');
  setLanguage('ru');
  assert.equal(serverText('Language must be en or ru.'), 'Язык должен быть en или ru.');
  assert.equal(serverText('Bucket already exists.'), 'Бакет уже существует.');
  assert.equal(serverText('Неверный логин или пароль.'), 'Неверный логин или пароль.');
  assert.equal(serverText('report.txt'), 'report.txt');
  setLanguage('en');
});
