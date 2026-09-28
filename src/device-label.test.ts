import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLabel } from './device-label';

const UA = {
    chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
    iphoneApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    ipadApp: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    androidPhone: 'Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1',
};

test('the apps are named for the device', () => {
    assert.equal(deviceLabel(UA.iphoneApp, 'ios'), 'iPhone');
    // iPadOS tells web content it is a Mac.
    assert.equal(deviceLabel(UA.ipadApp, 'ios'), 'iPad');
    assert.equal(deviceLabel(UA.androidPhone, 'android'), 'Android phone');
});

test('a browser is named for the browser and the system', () => {
    assert.equal(deviceLabel(UA.chromeMac, 'web'), 'Chrome on macOS');
    assert.equal(deviceLabel(UA.safariMac, 'web'), 'Safari on macOS');
    // Edge also says Chrome and Safari; it is still Edge.
    assert.equal(deviceLabel(UA.edgeWindows, 'web'), 'Edge on Windows');
    assert.equal(deviceLabel(UA.firefoxLinux, 'web'), 'Firefox on Linux');
    assert.equal(deviceLabel(UA.safariIphone, 'web'), 'Safari on iPhone');
});

test('an agent it cannot read still gets a name', () => {
    assert.equal(deviceLabel('', 'web'), 'A browser on a computer');
});
