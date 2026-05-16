/**
 * Comment Template Engine
 *
 * Variables supported:
 *   {page_name}     - ชื่อเพจ
 *   {clip_number}   - เลขคลิปปัจจุบัน
 *   {total_clips}   - จำนวนคลิปทั้งหมดของชุดนี้
 *   {date}          - วันที่โพสต์ (DD/MM/YYYY)
 *   {time}          - เวลาโพสต์ (HH:MM)
 *   {hashtag}       - hashtag ที่เพจตั้งไว้
 *   {caption}       - แคปชั่นของโพสต์
 *   {video_title}   - ชื่อคลิปต้นฉบับ
 *   {random:a|b|c}  - สุ่มเลือก 1 ค่า (syntax พิเศษ)
 *
 * Usage:
 *   const engine = new CommentTemplateEngine(dbPath);
 *   const comment = engine.pickAndRender(pageId, context);
 */

const Database = require('better-sqlite3');

class CommentTemplateEngine {
    constructor(dbPath) {
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
    }

    listTemplates(pageId) {
        return this.db.prepare(`
            SELECT * FROM comment_templates
            WHERE (page_id = ? OR page_id IS NULL) AND enabled = 1
            ORDER BY weight DESC
        `).all(pageId);
    }

    addTemplate(pageId, label, content, weight = 1) {
        const errors = this.validateTemplate(content);
        if (errors.length) {
            throw new Error(`Template invalid: ${errors.join(', ')}`);
        }
        const stmt = this.db.prepare(`
            INSERT INTO comment_templates (page_id, label, content, weight)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(pageId, label, content, weight).lastInsertRowid;
    }

    updateTemplate(id, fields) {
        const allowed = ['label', 'content', 'weight', 'enabled'];
        const updates = [];
        const values = [];
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                updates.push(`${key} = ?`);
                values.push(fields[key]);
            }
        }
        if (!updates.length) return;
        values.push(id);
        this.db.prepare(`UPDATE comment_templates SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    deleteTemplate(id) {
        this.db.prepare('DELETE FROM comment_templates WHERE id = ?').run(id);
    }

    /**
     * สุ่มเลือก template ตาม weight
     */
    pickRandom(pageId) {
        const templates = this.listTemplates(pageId);
        if (!templates.length) return null;

        const totalWeight = templates.reduce((sum, t) => sum + (t.weight || 1), 0);
        let rnd = Math.random() * totalWeight;

        for (const t of templates) {
            rnd -= (t.weight || 1);
            if (rnd <= 0) return t;
        }
        return templates[templates.length - 1];
    }

    /**
     * Render variables ลงใน template
     */
    render(content, context = {}) {
        const now = new Date();
        const vars = {
            page_name: context.page_name || '',
            clip_number: String(context.clip_number || 1),
            total_clips: String(context.total_clips || 1),
            date: this.formatDate(now),
            time: this.formatTime(now),
            hashtag: context.hashtag || '',
            caption: context.caption || '',
            video_title: context.video_title || ''
        };

        let rendered = content;

        rendered = rendered.replace(/\{random:([^}]+)\}/g, (match, choices) => {
            const options = choices.split('|').map(s => s.trim()).filter(s => s);
            if (!options.length) return '';
            return options[Math.floor(Math.random() * options.length)];
        });

        for (const [key, value] of Object.entries(vars)) {
            rendered = rendered.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }

        rendered = rendered.replace(/\{[a-z_]+\}/g, '');

        return rendered.trim();
    }

    /**
     * One-shot: สุ่ม + render
     */
    pickAndRender(pageId, context) {
        const template = this.pickRandom(pageId);
        if (!template) return null;
        return {
            template_id: template.id,
            label: template.label,
            rendered: this.render(template.content, context)
        };
    }

    /**
     * Validate template (เช็ค syntax)
     */
    validateTemplate(content) {
        const errors = [];
        if (!content || !content.trim()) {
            errors.push('Content cannot be empty');
        }
        if (content.length > 8000) {
            errors.push('Content too long (max 8000 chars)');
        }

        const validVars = ['page_name', 'clip_number', 'total_clips', 'date', 'time', 'hashtag', 'caption', 'video_title'];
        const usedVars = content.match(/\{([a-z_]+)\}/g) || [];
        for (const v of usedVars) {
            const name = v.slice(1, -1);
            if (!validVars.includes(name) && !name.startsWith('random:')) {
                errors.push(`Unknown variable: ${v}`);
            }
        }
        return errors;
    }

    formatDate(d) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = d.getFullYear();
        return `${dd}/${mm}/${yy}`;
    }

    formatTime(d) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    /**
     * Preview - ทดสอบ render ก่อน save (สำหรับ dry-run ใน UI)
     */
    preview(content, sampleContext) {
        const errors = this.validateTemplate(content);
        if (errors.length) {
            return { ok: false, errors };
        }
        return {
            ok: true,
            rendered: this.render(content, sampleContext || {
                page_name: 'รวมซีรีย์สั้น',
                clip_number: 3,
                total_clips: 10,
                hashtag: '#ซีรีย์จีน',
                caption: 'ดูฟรี...',
                video_title: 'ซีรีย์จีน EP.1'
            })
        };
    }
}

module.exports = { CommentTemplateEngine };
