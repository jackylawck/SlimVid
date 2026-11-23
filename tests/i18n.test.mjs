import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DICTIONARY, SUPPORTED_LANGS, t } from '../src/ui/i18n.js';

test('zh-HK 與 en 字典鍵值 100% 同步，且絕不含任何 HTML 標籤', () => {
  const baseKeys = Object.keys(DICTIONARY['zh-HK']).sort();

  for (const lang of SUPPORTED_LANGS) {
    const keys = Object.keys(DICTIONARY[lang]).sort();
    assert.deepEqual(keys, baseKeys, `${lang} 缺少或多出翻譯鍵`);

    for (const [k, val] of Object.entries(DICTIONARY[lang])) {
      assert.equal(typeof val, 'string');
      assert.ok(val.length > 0, `${lang}.${k} 不可為空`);
      assert.doesNotMatch(val, /[<>]/, `${lang}.${k} 禁止包含 HTML 括號以防 XSS`);
    }
  }
});

test('index.html 全部 data-i18n 鍵均存在於雙語字典中', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const matches = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)];
  assert.ok(matches.length > 0);

  for (const [, key] of matches) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DICTIONARY['zh-HK'], key),
      `index.html 引用了未定義的 i18n 鍵: ${key}`
    );
  }
});

test('t() 變數插值正常運作', () => {
  assert.equal(t('downloadBtn', { sizeMB: '18.50' }, 'en'), 'Download Compressed Video (18.50 MB)');
  assert.equal(t('downloadBtn', { sizeMB: '18.50' }, 'zh-HK'), '下載壓縮影片 (18.50 MB)');
});
