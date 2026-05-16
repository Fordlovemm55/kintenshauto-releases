# Plan 3 — Admin Panel (Next.js)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Next.js web admin panel deployed to Vercel that lets an organization admin manage KINTENSHAUTO users (create, suspend, delete), force-logout active sessions, publish app version policies (soft + force update), and view the audit log. The admin panel talks to the SAME Supabase project as the desktop app (`etutmagymtlfagcsvavk.supabase.co`).

**Architecture:**
- **Separate repo:** `kintenshauto-admin/` (sibling to `KINTENSHAUTO-Source-v1.0.0/` and `kintenshauto-cloud/`)
- **Framework:** Next.js 14+ (App Router) — server components for read paths, server actions for writes
- **Auth:** Supabase Auth — admin signs in with email/password. Admin privilege gated by `raw_app_meta_data.is_admin = true` on the user row (set manually via Supabase Studio or first-time setup script).
- **service_role usage:** ONLY in server-side API routes / server actions, never in client bundle. Vercel env vars hold the key.
- **UI:** Tailwind CSS + shadcn/ui (Radix primitives + Tailwind) — modern, accessible, copy-paste components
- **Deployment:** Vercel free tier (one-click deploy from GitHub)

**Prerequisites:**
- Plan 1 Phase C complete (Supabase project deployed) ✅
- `kintenshauto-cloud/PROJECT.md` has the deployed project ref + secrets
- An admin user account in Supabase with `raw_app_meta_data: {"is_admin": true}` (created in Phase B)
- Node.js 18+ + npm (already installed locally for desktop app dev)

**Tech Stack additions:**
- Next.js 14+, React 18 (Server Components)
- `@supabase/ssr` (Supabase SSR helpers for Next.js cookie-based auth)
- `@supabase/supabase-js` v2 (same as desktop)
- Tailwind CSS v3 + shadcn/ui
- TypeScript (Next.js default)
- `zod` for input validation in server actions

**Reference spec:** `../KINTENSHAUTO-Source-v1.0.0/docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md` (Section 5 covers admin panel routes)

---

## Phase A: Next.js scaffold + Supabase SSR (Tasks 1–3)

### Task 1: Initialize repo + Next.js + Tailwind + shadcn/ui

**Files (new repo — outside the desktop bundle):**
- Create directory: `C:/Users/Pc2026/Desktop/kintenshauto-admin/`
- Run scaffolding commands inside it

- [ ] **Step 1: Create + init repo**

```bash
cd C:/Users/Pc2026/Desktop
mkdir kintenshauto-admin
cd kintenshauto-admin
git init -b main
git config user.email "fordlovemm77@gmail.com"
git config user.name "KINTENSHAUTO Dev"
```

- [ ] **Step 2: Scaffold Next.js with TypeScript + Tailwind + App Router**

```bash
npx --yes create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
```

When prompted, accept all defaults (use App Router, no Turbopack — we want stable Webpack for now).

Verify:
```bash
ls
# Should see: app/ (under src/), public/, package.json, tsconfig.json, tailwind.config.ts, next.config.mjs
```

- [ ] **Step 3: Install Supabase + zod + shadcn dependencies**

```bash
npm install @supabase/supabase-js@^2.39.0 @supabase/ssr@^0.5.0 zod@^3.23.0
```

shadcn/ui doesn't ship as a package — it's a CLI that generates copy-pasteable components. Install it:

```bash
npx --yes shadcn@latest init -y
```

When prompted (or auto via -y):
- TypeScript: Yes
- Style: Default
- Base color: Slate
- CSS variables: Yes

This creates `components.json`, modifies `tailwind.config.ts`, sets up `src/lib/utils.ts`, and updates `src/app/globals.css`.

- [ ] **Step 4: Add a few shadcn components we'll use throughout**

```bash
npx --yes shadcn@latest add button input label table dialog dropdown-menu form badge card alert tabs
```

These end up under `src/components/ui/`. Verify:

```bash
ls src/components/ui/
# Should list: button.tsx, input.tsx, label.tsx, table.tsx, dialog.tsx, dropdown-menu.tsx, form.tsx, badge.tsx, card.tsx, alert.tsx, tabs.tsx
```

- [ ] **Step 5: Create initial README + .env.example**

Write `README.md`:

```markdown
# KINTENSHAUTO Admin Panel

Next.js admin web app for managing KINTENSHAUTO users, sessions, and app versions.
Talks to the same Supabase project as the desktop app.

## Routes

- `/login` — admin sign in (Supabase email/password)
- `/users` — list, create, suspend, delete users; reset device
- `/sessions` — list active devices; force logout
- `/versions` — publish app versions; toggle min_required
- `/audit` — filterable audit log viewer

## Local development

```bash
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
# fill in SUPABASE_SERVICE_ROLE_KEY (server-side only, NEVER exposed to client)
npm run dev
# open http://localhost:3000
```

## Deployment

Push to GitHub → Vercel auto-deploy (free tier). Set env vars in Vercel dashboard.

## Related

- Desktop app: `../KINTENSHAUTO-Source-v1.0.0/`
- Cloud project: `../kintenshauto-cloud/`
- Spec: `../KINTENSHAUTO-Source-v1.0.0/docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`
```

Write `.env.example`:

```
# Public (sent to client) — safe to commit values here as example
NEXT_PUBLIC_SUPABASE_URL=https://etutmagymtlfagcsvavk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxx

# Server-side only (NEVER exposed to client)
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxx
ADMIN_SHARED_SECRET=xxxxxxxxxxxxxxxxxxxx
SUPABASE_FUNCTIONS_URL=https://etutmagymtlfagcsvavk.supabase.co/functions/v1
```

Verify `.gitignore` from create-next-app already excludes `.env*.local` — confirm:

```bash
grep ".env" .gitignore
# Should include: .env*.local
```

- [ ] **Step 6: Commit baseline**

```bash
git add -A
git commit -m "chore: initial Next.js 14 scaffold with Tailwind + shadcn/ui + Supabase"
```

---

### Task 2: Supabase SSR helpers + auth middleware

**Files:**
- Create: `src/lib/supabase/server.ts` — server-side client (uses cookies)
- Create: `src/lib/supabase/client.ts` — browser client (read-only public stuff)
- Create: `src/lib/supabase/admin.ts` — server-side admin client (service_role; never expose)
- Create: `src/middleware.ts` — Next.js middleware that refreshes session cookies

- [ ] **Step 1: Server-side Supabase client**

Create `src/lib/supabase/server.ts`:

```typescript
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a server component — cookies are read-only there;
            // the middleware below handles the actual refresh write.
          }
        },
      },
    }
  );
}
```

- [ ] **Step 2: Browser-side Supabase client**

Create `src/lib/supabase/client.ts`:

```typescript
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

- [ ] **Step 3: Admin (service_role) client — SERVER ONLY**

Create `src/lib/supabase/admin.ts`:

```typescript
// SERVER-SIDE ONLY — never import from a client component or browser code.
// service_role bypasses RLS and can perform admin operations on auth.users.

import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
```

- [ ] **Step 4: Middleware to refresh session cookies**

Create `src/middleware.ts`:

```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // This refreshes the session if expired
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    // Match all paths except static assets + favicon
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

- [ ] **Step 5: Helper to require an admin in server components / server actions**

Create `src/lib/auth/requireAdmin.ts`:

```typescript
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  const isAdmin = (user.app_metadata?.is_admin === true)
    || (user.user_metadata?.is_admin === true && process.env.NODE_ENV === 'development');

  if (!isAdmin) {
    redirect('/login?error=not_admin');
  }

  return { user, supabase };
}
```

Note: `app_metadata.is_admin` is set server-side via service_role (it's NOT user-editable). `user_metadata.is_admin` is user-editable — we accept it only in dev for easier local testing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add Supabase SSR helpers + middleware + requireAdmin gate"
```

---

### Task 3: Login page

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/app/login/actions.ts` — server action for sign in

- [ ] **Step 1: Server action**

Create `src/app/login/actions.ts`:

```typescript
'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

export async function signIn(formData: FormData) {
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '');

  if (!email || !password) {
    return { error: 'Email and password are required' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Verify the user is an admin (we don't want non-admins logging in here at all)
  const isAdmin = data.user?.app_metadata?.is_admin === true;
  if (!isAdmin) {
    await supabase.auth.signOut();
    return { error: 'Account is not an admin' };
  }

  revalidatePath('/', 'layout');
  redirect('/users');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
```

- [ ] **Step 2: Login page UI**

Create `src/app/login/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { signIn } from './actions';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const searchParams = useSearchParams();
  const initialError =
    searchParams.get('error') === 'not_admin' ? 'Your account does not have admin access.' : null;

  async function handleSubmit(formData: FormData) {
    setError(null);
    setPending(true);
    const result = await signIn(formData);
    if (result?.error) {
      setError(result.error);
      setPending(false);
    }
    // Success → redirect handled in the server action
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">KINTENSHAUTO Admin</CardTitle>
          <CardDescription>Sign in with your admin email + password</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-4">
            {(error || initialError) && (
              <Alert variant="destructive">
                <AlertDescription>{error || initialError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Smoke test locally**

```bash
# In kintenshauto-admin/
cp .env.example .env.local
# Edit .env.local with real values from kintenshauto-cloud/PROJECT.md
npm run dev
# Open http://localhost:3000/login
```

You should see the login form. Sign-in will fail until Task 4 creates an admin user.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(login): admin login page + server action (Supabase SSR)"
```

---

## Phase B: Admin user setup + dashboard layout (Tasks 4–5)

### Task 4: Set up first admin user

**Files:**
- Create: `scripts/promote-admin.ts` — one-time helper to add `is_admin: true` to a user
- Create: `tsconfig.scripts.json` — to run TS scripts via `tsx`

- [ ] **Step 1: Install tsx for running TypeScript scripts**

```bash
npm install -D tsx@^4.7.0
```

- [ ] **Step 2: Write the promotion script**

Create `scripts/promote-admin.ts`:

```typescript
// Usage: npx tsx scripts/promote-admin.ts <user_email>
// Sets app_metadata.is_admin = true on the given user. Requires SUPABASE_SERVICE_ROLE_KEY.

import { createAdminClient } from '../src/lib/supabase/admin';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npx tsx scripts/promote-admin.ts <user_email>');
    process.exit(1);
  }

  const admin = createAdminClient();
  // List + find user by email (admin listUsers returns all)
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) { console.error('listUsers failed:', listErr.message); process.exit(1); }

  const user = list.users.find(u => u.email === email);
  if (!user) {
    console.error(`No user found with email: ${email}`);
    console.error(`Existing emails: ${list.users.map(u => u.email).join(', ')}`);
    process.exit(1);
  }

  const { data: updated, error: updateErr } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { ...user.app_metadata, is_admin: true },
  });
  if (updateErr) { console.error('update failed:', updateErr.message); process.exit(1); }

  console.log(`✓ Promoted ${email} to admin.`);
  console.log(`  user_id: ${updated.user.id}`);
  console.log(`  app_metadata: ${JSON.stringify(updated.user.app_metadata)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Add npm script**

In `package.json` `"scripts"`, add:

```json
"promote-admin": "tsx scripts/promote-admin.ts"
```

- [ ] **Step 4: Create an admin user via Supabase dashboard**

Go to https://supabase.com/dashboard/project/etutmagymtlfagcsvavk/auth/users → "Add user" → "Create new user":
- Email: pick a real email you'll remember (e.g., your personal email)
- Password: pick a strong one
- Auto-confirm email: Yes (so you can log in immediately)

Then run:

```bash
npm run promote-admin -- your-email@example.com
```

Expected: `✓ Promoted your-email@example.com to admin.`

- [ ] **Step 5: Verify login works**

```bash
npm run dev
# Open http://localhost:3000/login
# Sign in with the admin email + password
# Should redirect to /users (which will 404 until Task 5 creates the layout)
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(admin): add promote-admin script + initial admin user created in Supabase"
```

---

### Task 5: Authenticated layout + nav

**Files:**
- Create: `src/app/(admin)/layout.tsx` — protected layout with sidebar nav
- Create: `src/app/(admin)/users/page.tsx` — placeholder (filled in Phase C)
- Create: `src/components/admin/SidebarNav.tsx`
- Create: `src/components/admin/SignOutButton.tsx`

- [ ] **Step 1: Sidebar nav**

Create `src/components/admin/SidebarNav.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const items = [
  { href: '/users',    label: 'Users' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/versions', label: 'Versions' },
  { href: '/audit',    label: 'Audit Log' },
];

export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav className="space-y-1">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
            pathname.startsWith(item.href)
              ? 'bg-slate-100 text-slate-900'
              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Sign out button (client component using server action)**

Create `src/components/admin/SignOutButton.tsx`:

```tsx
'use client';

import { Button } from '@/components/ui/button';
import { signOut } from '@/app/login/actions';

export function SignOutButton() {
  return (
    <form action={signOut}>
      <Button variant="outline" size="sm" type="submit">Sign out</Button>
    </form>
  );
}
```

- [ ] **Step 3: Protected admin layout (App Router group route)**

Create `src/app/(admin)/layout.tsx`:

```tsx
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { SidebarNav } from '@/components/admin/SidebarNav';
import { SignOutButton } from '@/components/admin/SignOutButton';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireAdmin();

  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      <aside className="border-r border-slate-200 bg-white p-4 flex flex-col">
        <div className="mb-6">
          <h1 className="text-lg font-bold">KINTENSHAUTO</h1>
          <p className="text-xs text-slate-500">Admin Panel</p>
        </div>
        <SidebarNav />
        <div className="mt-auto pt-4 border-t border-slate-200 space-y-2">
          <p className="text-xs text-slate-500 truncate">{user.email}</p>
          <SignOutButton />
        </div>
      </aside>
      <main className="p-8 bg-slate-50">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Placeholder users page**

Create `src/app/(admin)/users/page.tsx`:

```tsx
export default function UsersPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Users</h1>
      <p className="text-slate-600">User management table coming in Phase C.</p>
    </div>
  );
}
```

- [ ] **Step 5: Smoke test**

```bash
npm run dev
# Sign in at /login → should redirect to /users showing the layout
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(admin): authenticated layout group + sidebar nav + sign out"
```

---

## Phase C: Users page (Tasks 6–8)

### Task 6: List users

**Files:**
- Modify: `src/app/(admin)/users/page.tsx`
- Create: `src/app/(admin)/users/UsersTable.tsx`

- [ ] **Step 1: Server-side data fetch**

Replace `src/app/(admin)/users/page.tsx`:

```tsx
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { UsersTable } from './UsersTable';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  await requireAdmin();
  const admin = createAdminClient();

  // List all users
  const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) {
    return <p className="text-red-600">Error loading users: {error.message}</p>;
  }

  // Get device claim status per user
  const userIds = list.users.map(u => u.id);
  const { data: devices } = userIds.length
    ? await admin.from('user_devices').select('user_id, device_label, last_seen_at').in('user_id', userIds)
    : { data: [] };
  const deviceMap = new Map((devices || []).map(d => [d.user_id, d]));

  const rows = list.users.map(u => ({
    id: u.id,
    email: u.email ?? '(no email)',
    created_at: u.created_at,
    is_admin: u.app_metadata?.is_admin === true,
    banned_until: u.banned_until || null,
    device_label: deviceMap.get(u.id)?.device_label || null,
    last_seen_at: deviceMap.get(u.id)?.last_seen_at || null,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-slate-500">{rows.length} total</p>
        </div>
        <Link href="/users/new">
          <Button>+ Add User</Button>
        </Link>
      </div>
      <UsersTable users={rows} />
    </div>
  );
}
```

- [ ] **Step 2: Users table client component**

Create `src/app/(admin)/users/UsersTable.tsx`:

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resetDevice, suspendUser, unsuspendUser, deleteUser } from './actions';

interface User {
  id: string;
  email: string;
  created_at: string;
  is_admin: boolean;
  banned_until: string | null;
  device_label: string | null;
  last_seen_at: string | null;
}

export function UsersTable({ users }: { users: User[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function handleAction(action: () => Promise<void>) {
    startTransition(async () => {
      await action();
      router.refresh();
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Device</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map(u => (
          <TableRow key={u.id}>
            <TableCell className="font-medium">
              {u.email}
              {u.is_admin && <Badge className="ml-2" variant="secondary">admin</Badge>}
            </TableCell>
            <TableCell>
              {u.banned_until
                ? <Badge variant="destructive">Suspended</Badge>
                : <Badge variant="outline">Active</Badge>}
            </TableCell>
            <TableCell className="text-sm text-slate-600">
              {u.device_label || <span className="text-slate-400">—</span>}
            </TableCell>
            <TableCell className="text-sm text-slate-600">
              {u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : '—'}
            </TableCell>
            <TableCell className="text-sm text-slate-600">
              {new Date(u.created_at).toLocaleDateString()}
            </TableCell>
            <TableCell className="text-right">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={pending}>•••</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleAction(() => resetDevice(u.id))}>
                    Reset device
                  </DropdownMenuItem>
                  {u.banned_until
                    ? <DropdownMenuItem onClick={() => handleAction(() => unsuspendUser(u.id))}>
                        Unsuspend
                      </DropdownMenuItem>
                    : <DropdownMenuItem onClick={() => handleAction(() => suspendUser(u.id))}>
                        Suspend
                      </DropdownMenuItem>}
                  <DropdownMenuItem
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(`Delete ${u.email}? This cannot be undone.`)) {
                        handleAction(() => deleteUser(u.id));
                      }
                    }}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
        {users.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-slate-500 py-8">No users yet</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Verify**

```bash
npm run dev
# Visit /users — should show your admin user + any test smoke-test users
```

Don't commit yet — actions.ts is required for the table to work. Bundle with Task 7.

---

### Task 7: User actions (create, suspend, delete, reset device)

**Files:**
- Create: `src/app/(admin)/users/actions.ts`
- Create: `src/app/(admin)/users/new/page.tsx` (and its actions)

- [ ] **Step 1: Server actions**

Create `src/app/(admin)/users/actions.ts`:

```typescript
'use server';

import { requireAdmin } from '@/lib/auth/requireAdmin';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';

export async function suspendUser(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  // 100 years ban = effectively permanent
  const banUntil = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
  if (error) throw error;
  await admin.from('audit_log').insert({
    user_id: userId, event: 'admin_suspend_user',
    detail_json: { by: 'admin', until: banUntil }
  });
  revalidatePath('/users');
}

export async function unsuspendUser(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: 'none' });
  if (error) throw error;
  await admin.from('audit_log').insert({
    user_id: userId, event: 'admin_unsuspend_user', detail_json: { by: 'admin' }
  });
  revalidatePath('/users');
}

export async function deleteUser(userId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw error;
  // CASCADE on user_id FK removes user_devices, user_secrets, cloud_* rows
  await admin.from('audit_log').insert({
    user_id: null,  // user is gone — cannot reference
    event: 'admin_delete_user', detail_json: { deleted_user_id: userId, by: 'admin' }
  });
  revalidatePath('/users');
}

export async function resetDevice(userId: string) {
  await requireAdmin();
  // Call the admin-reset-device edge function (Plan 1 Phase C)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const adminSecret = process.env.ADMIN_SHARED_SECRET!;
  const url = process.env.SUPABASE_FUNCTIONS_URL || `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`;

  const res = await fetch(`${url}/admin-reset-device`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'X-Admin-Auth': adminSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`reset device failed: ${res.status} ${txt}`);
  }
  revalidatePath('/users');
}
```

- [ ] **Step 2: Add user form**

Create `src/app/(admin)/users/new/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createUser } from './actions';

export default function NewUserPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(formData: FormData) {
    setError(null);
    setPending(true);
    const result = await createUser(formData);
    if (result?.error) {
      setError(result.error);
      setPending(false);
      return;
    }
    router.push('/users');
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Add User</h1>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>New user details</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Initial password</Label>
              <Input id="password" name="password" type="password" required minLength={8} />
              <p className="text-xs text-slate-500">User can change after first login.</p>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create user'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

Create `src/app/(admin)/users/new/actions.ts`:

```typescript
'use server';

import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';

const Schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function createUser(formData: FormData) {
  await requireAdmin();
  const raw = {
    email: String(formData.get('email') || '').trim(),
    password: String(formData.get('password') || ''),
  };
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Invalid input' };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,  // skip the confirm email flow
  });
  if (error) return { error: error.message };

  await admin.from('audit_log').insert({
    user_id: data.user.id,
    event: 'admin_create_user',
    detail_json: { by: 'admin', email: parsed.data.email },
  });

  revalidatePath('/users');
  return { ok: true };
}
```

- [ ] **Step 3: Commit + test**

```bash
git add -A
git commit -m "feat(users): list + create + suspend + delete + reset device

CRUD page for managing KINTENSHAUTO users via Supabase admin API.
- Server-side fetch via admin client (service_role)
- Client-side table with dropdown actions
- Reset device calls admin-reset-device edge function (Plan 1 Phase C)
- Suspend uses ban_duration='876000h' (effectively forever)
- Delete cascades through user_devices + user_secrets + cloud_* tables
- Audit log entries for every admin action"
```

Test in browser:
1. `/users` shows your admin user + smoke test users
2. Click `+ Add User` → create a new user → returns to list with new row
3. Click "..." on a user → Suspend → row badge becomes "Suspended"
4. Click "..." on a user → Reset device → device label clears
5. Click "..." → Delete → user disappears after confirm

---

### Task 8: Confirm everything ties together

Quick visual smoke pass — no new code, just verify.

- [ ] **Step 1: End-to-end check**

1. Sign out of admin panel
2. Sign in as the desktop app's smoke-test user via the desktop login (if it works) OR via the test commands you used in Plan 1 Phase C
3. As admin, click "Reset device" on that user
4. Confirm: `audit_log` has `admin_reset_device` event; the `user_devices` row is gone
5. The desktop user (if still active) should get kicked via Realtime within seconds (Plan 2 Task 9 subscriber)

- [ ] **Step 2: Commit only if anything was fixed**

```bash
git status
# If clean, skip the commit
```

---

## Phase D: Sessions + force logout (Task 9)

### Task 9: Sessions page

**Files:**
- Create: `src/app/(admin)/sessions/page.tsx`
- Create: `src/app/(admin)/sessions/SessionsTable.tsx`
- Create: `src/app/(admin)/sessions/actions.ts`

- [ ] **Step 1: Sessions list page**

Create `src/app/(admin)/sessions/page.tsx`:

```tsx
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { SessionsTable } from './SessionsTable';

export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  await requireAdmin();
  const admin = createAdminClient();

  // Join user_devices to auth.users for email display
  const { data: rows, error } = await admin
    .from('user_devices')
    .select('user_id, device_id, device_label, claimed_at, last_seen_at, session_token')
    .order('last_seen_at', { ascending: false });

  if (error) return <p className="text-red-600">Error: {error.message}</p>;

  // Fetch emails in one batch
  const userIds = (rows || []).map(r => r.user_id);
  const { data: usersList } = userIds.length
    ? await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    : { data: { users: [] } };
  const emailById = new Map((usersList?.users || []).map(u => [u.id, u.email ?? '(no email)']));

  const enriched = (rows || []).map(r => ({
    ...r,
    email: emailById.get(r.user_id) ?? '(unknown)',
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Active Sessions</h1>
          <p className="text-sm text-slate-500">{enriched.length} device(s) currently claimed</p>
        </div>
      </div>
      <SessionsTable sessions={enriched} />
    </div>
  );
}
```

- [ ] **Step 2: Sessions table + force-logout action**

Create `src/app/(admin)/sessions/SessionsTable.tsx`:

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { forceLogout } from './actions';

interface Session {
  user_id: string;
  email: string;
  device_label: string | null;
  claimed_at: string;
  last_seen_at: string;
}

export function SessionsTable({ sessions }: { sessions: Session[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function handleKick(userId: string, email: string) {
    if (!confirm(`Force ${email} to sign out? They'll see "Signed in on another device" message.`)) return;
    startTransition(async () => {
      await forceLogout(userId);
      router.refresh();
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Device</TableHead>
          <TableHead>Claimed</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map(s => (
          <TableRow key={s.user_id}>
            <TableCell className="font-medium">{s.email}</TableCell>
            <TableCell>{s.device_label || '—'}</TableCell>
            <TableCell className="text-sm text-slate-600">{new Date(s.claimed_at).toLocaleString()}</TableCell>
            <TableCell className="text-sm text-slate-600">{new Date(s.last_seen_at).toLocaleString()}</TableCell>
            <TableCell className="text-right">
              <Button variant="destructive" size="sm" disabled={pending}
                onClick={() => handleKick(s.user_id, s.email)}>
                Force logout
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {sessions.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-slate-500 py-8">
              No active sessions
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Force logout action (reuses admin-reset-device edge function)**

Create `src/app/(admin)/sessions/actions.ts`:

```typescript
'use server';

import { requireAdmin } from '@/lib/auth/requireAdmin';
import { revalidatePath } from 'next/cache';

export async function forceLogout(userId: string) {
  await requireAdmin();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const adminSecret = process.env.ADMIN_SHARED_SECRET!;
  const url = process.env.SUPABASE_FUNCTIONS_URL || `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`;

  const res = await fetch(`${url}/admin-reset-device`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceKey}`,
      'X-Admin-Auth': adminSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new Error(`force logout failed: ${res.status}`);
  revalidatePath('/sessions');
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(sessions): list active devices + force logout via admin-reset-device"
```

---

## Phase E: Versions page (Task 10)

### Task 10: App versions CRUD

**Files:**
- Create: `src/app/(admin)/versions/page.tsx`
- Create: `src/app/(admin)/versions/VersionsTable.tsx`
- Create: `src/app/(admin)/versions/actions.ts`
- Create: `src/app/(admin)/versions/new/page.tsx` (form)

- [ ] **Step 1: Versions list page**

Create `src/app/(admin)/versions/page.tsx`:

```tsx
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { VersionsTable } from './VersionsTable';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function VersionsPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const { data: versions, error } = await admin
    .from('app_versions')
    .select('id, version, min_required, release_notes_md, download_url, published_at')
    .order('published_at', { ascending: false });

  if (error) return <p className="text-red-600">Error: {error.message}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">App Versions</h1>
          <p className="text-sm text-slate-500">{versions?.length || 0} version(s) published</p>
        </div>
        <Link href="/versions/new">
          <Button>+ Publish Version</Button>
        </Link>
      </div>
      <VersionsTable versions={versions || []} />
    </div>
  );
}
```

- [ ] **Step 2: Versions table with toggle min_required**

Create `src/app/(admin)/versions/VersionsTable.tsx`:

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toggleRequired, deleteVersion } from './actions';

interface Version {
  id: string;
  version: string;
  min_required: boolean;
  release_notes_md: string | null;
  download_url: string | null;
  published_at: string;
}

export function VersionsTable({ versions }: { versions: Version[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function handleToggle(id: string, current: boolean) {
    if (!current) {
      if (!confirm('Marking this as MINIMUM REQUIRED will force all clients on older versions to update immediately. Continue?')) return;
    }
    startTransition(async () => {
      await toggleRequired(id, !current);
      router.refresh();
    });
  }

  async function handleDelete(id: string, version: string) {
    if (!confirm(`Delete version ${version}? This removes it from the registry but does NOT delete the installer files on GitHub Releases.`)) return;
    startTransition(async () => {
      await deleteVersion(id);
      router.refresh();
    });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Published</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map(v => (
          <TableRow key={v.id}>
            <TableCell className="font-mono font-medium">{v.version}</TableCell>
            <TableCell>
              {v.min_required
                ? <Badge variant="destructive">Force Update</Badge>
                : <Badge variant="outline">Soft Update</Badge>}
            </TableCell>
            <TableCell className="text-sm text-slate-600">{new Date(v.published_at).toLocaleString()}</TableCell>
            <TableCell className="text-sm text-slate-600 max-w-md truncate">
              {v.release_notes_md?.split('\n')[0] || '—'}
            </TableCell>
            <TableCell className="text-right space-x-2">
              <Button variant="outline" size="sm" disabled={pending}
                onClick={() => handleToggle(v.id, v.min_required)}>
                {v.min_required ? 'Make Soft' : 'Make Required'}
              </Button>
              <Button variant="ghost" size="sm" className="text-red-600" disabled={pending}
                onClick={() => handleDelete(v.id, v.version)}>
                Delete
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {versions.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-slate-500 py-8">
              No versions published yet
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Versions actions + publish form**

Create `src/app/(admin)/versions/actions.ts`:

```typescript
'use server';

import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { createAdminClient } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

const PublishSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-\w+(\.\d+)?)?$/, 'Must be semver (e.g. 1.2.3 or 1.2.3-beta.1)'),
  release_notes_md: z.string().optional(),
  download_url: z.string().url().optional().or(z.literal('')),
  min_required: z.boolean(),
});

export async function publishVersion(formData: FormData) {
  const { user } = await requireAdmin();
  const raw = {
    version: String(formData.get('version') || '').trim(),
    release_notes_md: String(formData.get('release_notes_md') || ''),
    download_url: String(formData.get('download_url') || ''),
    min_required: formData.get('min_required') === 'on',
  };
  const parsed = PublishSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? 'Invalid input' };
  }

  const admin = createAdminClient();
  const { error } = await admin.from('app_versions').insert({
    version: parsed.data.version,
    release_notes_md: parsed.data.release_notes_md || null,
    download_url: parsed.data.download_url || null,
    min_required: parsed.data.min_required,
    published_by: user.id,
  });
  if (error) return { error: error.message };

  await admin.from('audit_log').insert({
    user_id: user.id,
    event: 'admin_publish_version',
    detail_json: {
      version: parsed.data.version,
      min_required: parsed.data.min_required,
    },
  });

  revalidatePath('/versions');
  redirect('/versions');
}

export async function toggleRequired(id: string, newValue: boolean) {
  const { user } = await requireAdmin();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('app_versions')
    .update({ min_required: newValue })
    .eq('id', id)
    .select('version')
    .single();
  if (error) throw error;

  await admin.from('audit_log').insert({
    user_id: user.id,
    event: 'admin_toggle_min_required',
    detail_json: { version: data.version, min_required: newValue },
  });
  revalidatePath('/versions');
}

export async function deleteVersion(id: string) {
  const { user } = await requireAdmin();
  const admin = createAdminClient();
  const { data: row } = await admin.from('app_versions').select('version').eq('id', id).single();
  const { error } = await admin.from('app_versions').delete().eq('id', id);
  if (error) throw error;
  await admin.from('audit_log').insert({
    user_id: user.id,
    event: 'admin_delete_version',
    detail_json: { version: row?.version },
  });
  revalidatePath('/versions');
}
```

Create `src/app/(admin)/versions/new/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { publishVersion } from '../actions';

export default function NewVersionPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(formData: FormData) {
    setError(null);
    setPending(true);
    const result = await publishVersion(formData);
    if (result?.error) {
      setError(result.error);
      setPending(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Publish New Version</h1>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Version details</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="version">Version (semver)</Label>
              <Input id="version" name="version" placeholder="1.2.0" required pattern="^\d+\.\d+\.\d+(-\w+(\.\d+)?)?$" />
              <p className="text-xs text-slate-500">Match the package.json version of the corresponding desktop build.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="download_url">Download URL (optional)</Label>
              <Input id="download_url" name="download_url" type="url" placeholder="https://github.com/.../releases/.../KINTENSHAUTO-Setup-1.2.0.exe" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="release_notes_md">Release notes (markdown)</Label>
              <textarea
                id="release_notes_md" name="release_notes_md" rows={6}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm font-mono"
                placeholder="- Fixed FB page-switch&#10;- Faster cover generation"
              />
            </div>
            <div className="flex items-center gap-2">
              <input id="min_required" name="min_required" type="checkbox" className="h-4 w-4" />
              <Label htmlFor="min_required" className="font-normal cursor-pointer">
                Force all users on older versions to update immediately
              </Label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Publishing…' : 'Publish'}
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Commit + test**

```bash
git add -A
git commit -m "feat(versions): publish + toggle min_required + delete with semver validation"
```

Test:
1. `/versions` shows empty (no rows yet)
2. `+ Publish Version` → enter `1.0.0` + notes + click `Publish` → list shows row
3. Click `Make Required` → status becomes `Force Update` (with confirmation prompt)
4. Open desktop app (Plan 2) — at next launch, force update modal should appear
5. `Delete` removes row

---

## Phase F: Audit log viewer (Task 11)

### Task 11: Audit log page with filters

**Files:**
- Create: `src/app/(admin)/audit/page.tsx`
- Create: `src/app/(admin)/audit/AuditTable.tsx`

- [ ] **Step 1: Audit list with search params filters**

Create `src/app/(admin)/audit/page.tsx`:

```tsx
import { createAdminClient } from '@/lib/supabase/admin';
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { AuditTable } from './AuditTable';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

interface SearchParams {
  user_id?: string;
  event?: string;
  limit?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const admin = createAdminClient();

  const limit = Math.min(Math.max(parseInt(sp.limit || '100', 10), 10), 500);

  let q = admin
    .from('audit_log')
    .select('id, user_id, event, detail_json, ip, created_at')
    .order('id', { ascending: false })
    .limit(limit);

  if (sp.user_id) q = q.eq('user_id', sp.user_id);
  if (sp.event) q = q.eq('event', sp.event);

  const { data: rows, error } = await q;
  if (error) return <p className="text-red-600">Error: {error.message}</p>;

  // Build email map
  const userIds = Array.from(new Set((rows || []).map(r => r.user_id).filter(Boolean) as string[]));
  let emailById = new Map<string, string>();
  if (userIds.length) {
    const { data: usersList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    emailById = new Map((usersList?.users || []).map(u => [u.id, u.email ?? '(no email)']));
  }
  const enriched = (rows || []).map(r => ({
    ...r,
    email: r.user_id ? (emailById.get(r.user_id) ?? r.user_id) : '(system)',
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Audit Log</h1>
      <form className="flex gap-2 items-end mb-6">
        <div>
          <Label htmlFor="user_id">User ID</Label>
          <Input id="user_id" name="user_id" defaultValue={sp.user_id || ''} placeholder="filter by user uuid" className="w-72" />
        </div>
        <div>
          <Label htmlFor="event">Event</Label>
          <Input id="event" name="event" defaultValue={sp.event || ''} placeholder="e.g. device_claim" className="w-48" />
        </div>
        <div>
          <Label htmlFor="limit">Limit</Label>
          <Input id="limit" name="limit" type="number" defaultValue={limit} min={10} max={500} className="w-20" />
        </div>
        <Button type="submit">Filter</Button>
      </form>
      <AuditTable rows={enriched} />
    </div>
  );
}
```

- [ ] **Step 2: Audit table component**

Create `src/app/(admin)/audit/AuditTable.tsx`:

```tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

interface Row {
  id: number;
  user_id: string | null;
  email: string;
  event: string;
  detail_json: unknown;
  ip: string | null;
  created_at: string;
}

const SEVERE_EVENTS = new Set([
  'admin_delete_user', 'admin_suspend_user', 'admin_reset_device',
  'device_takeover', 'login_failure',
]);

export function AuditTable({ rows }: { rows: Row[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">ID</TableHead>
          <TableHead className="w-44">Time</TableHead>
          <TableHead className="w-56">Event</TableHead>
          <TableHead className="w-64">User</TableHead>
          <TableHead className="w-32">IP</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(r => (
          <TableRow key={r.id}>
            <TableCell className="font-mono text-xs">{r.id}</TableCell>
            <TableCell className="text-xs text-slate-600">
              {new Date(r.created_at).toLocaleString()}
            </TableCell>
            <TableCell>
              <Badge variant={SEVERE_EVENTS.has(r.event) ? 'destructive' : 'outline'}>
                {r.event}
              </Badge>
            </TableCell>
            <TableCell className="text-sm">{r.email}</TableCell>
            <TableCell className="text-xs font-mono">{r.ip || '—'}</TableCell>
            <TableCell className="text-xs font-mono text-slate-600 max-w-md truncate">
              {r.detail_json ? JSON.stringify(r.detail_json) : ''}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="text-center text-slate-500 py-8">
              No matching events
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(audit): filterable audit log viewer (event + user_id + limit)"
```

---

## Phase G: Deploy to Vercel + final docs (Task 12)

### Task 12: Vercel deployment + README + DEPLOY.md

- [ ] **Step 1: Push to GitHub**

Create a GitHub repo named `kintenshauto-admin` (private). Then:

```bash
cd C:/Users/Pc2026/Desktop/kintenshauto-admin
git remote add origin https://github.com/<your-user>/kintenshauto-admin.git
git push -u origin main
```

- [ ] **Step 2: Connect to Vercel**

1. Go to https://vercel.com/new
2. Import the GitHub repo `kintenshauto-admin`
3. Framework: Next.js (auto-detected)
4. Build command: `npm run build` (default)
5. Output directory: leave default

Click **Deploy** — first deploy will fail because env vars aren't set. That's expected.

- [ ] **Step 3: Set env vars in Vercel**

In Vercel dashboard → Project → Settings → Environment Variables, add:

```
NEXT_PUBLIC_SUPABASE_URL        https://etutmagymtlfagcsvavk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY   sb_publishable_zlRdIib67v6B8cml000r2g_t8Ne-K_0
SUPABASE_SERVICE_ROLE_KEY       REDACTED_SUPABASE_SERVICE_ROLE
ADMIN_SHARED_SECRET             REDACTED_ADMIN_SHARED_SECRET
SUPABASE_FUNCTIONS_URL          https://etutmagymtlfagcsvavk.supabase.co/functions/v1
```

Set scope to "Production, Preview, Development" for all.

After saving, click **Redeploy** in the Deployments tab.

- [ ] **Step 4: Verify production**

Visit the Vercel URL (e.g., `https://kintenshauto-admin.vercel.app`) → /login → sign in with admin email → confirm /users, /sessions, /versions, /audit all work.

- [ ] **Step 5: Write DEPLOY.md**

Create `kintenshauto-admin/DEPLOY.md`:

```markdown
# Deployment

## Vercel (production)

1. Push to `main` on GitHub — Vercel auto-deploys.
2. Production URL: `https://kintenshauto-admin.vercel.app`

## Required env vars (set in Vercel dashboard)

| Variable | Source |
|----------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key — safe to expose to browser |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** — server-side only, bypasses RLS |
| `ADMIN_SHARED_SECRET` | Random hex from `supabase secrets set ADMIN_SHARED_SECRET` |
| `SUPABASE_FUNCTIONS_URL` | `https://<ref>.supabase.co/functions/v1` |

## Initial admin user

If you don't have an admin yet:
1. Create a user via Supabase Studio → Auth → Users → Add user
2. Run locally: `npm run promote-admin -- <email>` (requires `.env.local`)
3. Log in to the admin panel

## Add another admin

Once at least one admin exists:
- Currently only via the `promote-admin` script
- Future enhancement: add a "Make admin" action to the Users table (Phase 2 of Plan 3)

## Rotate secrets

If `SUPABASE_SERVICE_ROLE_KEY` or `ADMIN_SHARED_SECRET` leaks:
1. Reset in Supabase dashboard
2. Update Vercel env vars
3. Trigger a redeploy
```

- [ ] **Step 6: Commit + push**

```bash
git add DEPLOY.md
git commit -m "docs: add DEPLOY.md with Vercel + env var instructions"
git push
git tag plan3-complete
git push --tags
```

---

## Done. What Plan 3 produced

After all 12 tasks:
- Fully functional admin panel deployed to Vercel
- 5 routes: /login, /users, /sessions, /versions, /audit
- Admin authentication via Supabase + `app_metadata.is_admin` gate
- User CRUD with reset-device + suspend + delete
- Force-logout via admin-reset-device edge function (Plan 1 Phase C)
- Version publishing with min_required toggle (drives force-update in desktop app)
- Filterable audit log
- All admin actions audited in `audit_log` table
- Tailwind + shadcn/ui for accessible, modern UI
- No client-side service_role exposure — all admin ops via server actions

**The full system is now in place:**
- Desktop app (`KINTENSHAUTO-Source-v1.0.0`) — branch `plan2-cloud-integration`, 94 tests
- Cloud project (`kintenshauto-cloud`) — deployed to `etutmagymtlfagcsvavk.supabase.co`
- Admin panel (`kintenshauto-admin`) — deployed to Vercel

**No follow-up plans needed for MVP.** Future polish ideas (out of scope):
- Inline preview of desktop screenshots in audit log
- Bulk operations (suspend N users at once)
- Email notifications when a force-update is published
- Subscription billing (if KINTENSHAUTO moves beyond internal org use)
- Per-user feature flags (Pro vs Free tier)
