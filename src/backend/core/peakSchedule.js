/**
 * Peak-hour scheduler for Facebook Reels
 *
 * Schedules clips at the times Thai users actually watch FB Reels:
 *   07:00 — เช้า (commute)
 *   12:30 — เที่ยง (lunch)
 *   18:00 — เย็น (after work)
 *   20:00 — ค่ำ Prime Time
 *   22:00 — ดึก (before bed)
 *
 * Each peak slot has a friendly Thai label so the UI can explain to user
 * "EP 4 → จะลงวันที่ 19 เม.ย. เวลา 20:00 (ค่ำ · Prime Time — คนดูเยอะที่สุด)"
 */

// Default Thai-time peak slots
const PEAK_SLOTS = [
    { hour: 7,  minute: 0,  label: 'เช้า · ก่อนเริ่มวัน',     why: 'คนเช็คโทรศัพท์ระหว่างเดินทาง' },
    { hour: 12, minute: 30, label: 'เที่ยง · พักเที่ยง',     why: 'คนพักเที่ยง เปิดดูระหว่างกินข้าว' },
    { hour: 18, minute: 0,  label: 'เย็น · เลิกงาน',         why: 'คนกลับบ้าน เปิดดูระหว่างเดินทาง' },
    { hour: 20, minute: 0,  label: 'ค่ำ · Prime Time',      why: 'ช่วงคนดู Reel เยอะที่สุด เอนจิ้นเฟสบุ๊กแสดงโพสต์มากสุด' },
    { hour: 22, minute: 0,  label: 'ดึก · ก่อนนอน',         why: 'คนนอนเล่นบนเตียง engagement สูง' }
];

/**
 * Convert a list of "HH:MM" strings into the slot shape used internally.
 * Returns null when the list is empty/invalid so callers fall back to PEAK_SLOTS.
 */
function customSlots(times) {
    if (!Array.isArray(times) || !times.length) return null;
    const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const parsed = times
        .map(t => {
            const m = re.exec(t);
            if (!m) return null;
            return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10),
                     label: t, why: 'จากที่ตั้งเองในหน้าคิวงาน' };
        })
        .filter(Boolean)
        .sort((a, b) => (a.hour - b.hour) || (a.minute - b.minute));
    return parsed.length ? parsed : null;
}

/**
 * Find the next slot after `afterTime`, respecting min cooldown.
 *
 * @param {Date} afterTime
 * @param {number} cooldownMin
 * @param {string[]} [customTimes]  Optional list of "HH:MM" strings to use
 *   instead of the global PEAK_SLOTS. When provided + non-empty, schedules
 *   are page-specific (driven by the page's `post_times` column).
 */
function nextPeakSlotAfter(afterTime, cooldownMin = 30, customTimes) {
    const slots = customSlots(customTimes) || PEAK_SLOTS;
    const earliest = new Date(afterTime.getTime() + cooldownMin * 60 * 1000);

    for (let dayOffset = 0; dayOffset < 60; dayOffset++) {
        const day = new Date(earliest);
        day.setDate(earliest.getDate() + dayOffset);
        for (const slot of slots) {
            const candidate = new Date(day);
            candidate.setHours(slot.hour, slot.minute, 0, 0);
            if (candidate > earliest) {
                return { date: candidate, slot };
            }
        }
    }
    return { date: earliest, slot: slots[0] };
}

/**
 * Plan N clips across peak slots starting from `startTime`.
 *
 * @param {string[]} [customTimes]  See nextPeakSlotAfter.
 */
function planClipSchedule(numClips, startTime = new Date(), cooldownMin = 30, customTimes) {
    const plan = [];
    let lastTime = new Date(startTime.getTime() - cooldownMin * 60 * 1000);
    for (let i = 0; i < numClips; i++) {
        const next = nextPeakSlotAfter(lastTime, cooldownMin, customTimes);
        const dayOffset = Math.floor((next.date - new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate())) / 86400000);
        plan.push({
            date: next.date,
            slot: next.slot,
            dayOffset,
            clipIndex: i + 1
        });
        lastTime = next.date;
    }
    return plan;
}

/**
 * Format a Date for SQLite datetime column (local time, "YYYY-MM-DD HH:MM:SS")
 */
function toSqlLocal(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
           `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Friendly Thai date label, e.g. "วันนี้ 20:00", "พรุ่งนี้ 12:30", "ศ. 19 เม.ย. 18:00"
 */
function friendlyThaiDate(date, refDate = new Date()) {
    const ref = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((day - ref) / 86400000);
    const pad = n => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    if (diffDays === 0) return `วันนี้ ${time}`;
    if (diffDays === 1) return `พรุ่งนี้ ${time}`;
    if (diffDays === 2) return `มะรืน ${time}`;
    if (diffDays === -1) return `เมื่อวาน ${time}`;

    const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const days = ['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];
    return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${time}`;
}

module.exports = {
    PEAK_SLOTS,
    nextPeakSlotAfter,
    planClipSchedule,
    toSqlLocal,
    friendlyThaiDate
};
