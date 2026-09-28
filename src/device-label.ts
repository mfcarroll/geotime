// src/device-label.ts
//
// What a device is called in "Your devices", so that a person looking at the
// list can tell which one to remove — and, when approving a link, what it is
// they are letting in.
//
// Coarse on purpose: "Chrome on macOS", not a model number. It is a hint for
// the person who owns both devices, chosen by this app rather than by them, and
// nothing about it is a fact anybody else is shown.

export type DevicePlatform = 'ios' | 'android' | 'web';

export function deviceLabel(userAgent: string, platform: DevicePlatform): string {
    const ua = userAgent || '';

    // iPadOS reports itself as a Mac to web content, WKWebView included, so an
    // iOS build that does not say iPhone is an iPad.
    if (platform === 'ios') return /iPhone/.test(ua) ? 'iPhone' : 'iPad';
    if (platform === 'android') return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';

    return `${browserName(ua)} on ${systemName(ua)}`;
}

function browserName(ua: string): string {
    // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'A browser';
}

function systemName(ua: string): string {
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return 'a computer';
}
