/**
 * Platform Config — Centralized per-platform settings for multi-platform profile support.
 *
 * Supported platforms:
 *  - facebook: existing FB profile flow (default for legacy profiles)
 *  - x: X / Twitter — used for scraping channel posts via authenticated Puppeteer
 *  - instagram: IG — same scraping approach as X (login required)
 *
 * IMPORTANT: 'facebook' is the default for any unknown/legacy platform value.
 * Existing profiles without a platform column will be treated as facebook,
 * keeping the FB login flow identical to before.
 */

const PLATFORM_CONFIG = {
    facebook: {
        label: 'Facebook',
        loginUrl: 'https://www.facebook.com/',
        cookieDomainPatterns: ['facebook.com', '.fb.com'],
        loginCookieNames: ['c_user', 'xs'],
        userDataPrefix: 'profile',          // chrome-profiles/profile_<timestamp>/  (legacy — unchanged)
    },
    x: {
        label: 'X (Twitter)',
        loginUrl: 'https://x.com/home',
        cookieDomainPatterns: ['x.com', 'twitter.com', '.twitter.com'],
        loginCookieNames: ['auth_token', 'ct0'],
        userDataPrefix: 'x_profile',        // chrome-profiles/x_profile_<timestamp>/
    },
    instagram: {
        label: 'Instagram',
        loginUrl: 'https://www.instagram.com/',
        cookieDomainPatterns: ['instagram.com', '.instagram.com'],
        loginCookieNames: ['sessionid', 'ds_user_id'],
        userDataPrefix: 'ig_profile',       // chrome-profiles/ig_profile_<timestamp>/
    },
};

const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_CONFIG);

function getPlatformConfig(platform) {
    return PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.facebook;
}

function isDomainForPlatform(domain, platform) {
    if (!domain) return false;
    const cfg = getPlatformConfig(platform);
    return cfg.cookieDomainPatterns.some(p => domain.includes(p));
}

function isUrlForPlatform(url, platform) {
    if (!url) return false;
    const cfg = getPlatformConfig(platform);
    return cfg.cookieDomainPatterns.some(p => url.includes(p));
}

function getUserDataPrefix(platform) {
    return getPlatformConfig(platform).userDataPrefix;
}

module.exports = {
    PLATFORM_CONFIG,
    SUPPORTED_PLATFORMS,
    getPlatformConfig,
    isDomainForPlatform,
    isUrlForPlatform,
    getUserDataPrefix,
};
