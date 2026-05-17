# White Screen of Death: Fix & Recovery Guide

## Problem Summary

The Admin and Student dashboards were rendering blank screens ("White Screen of Death") after database schema cleanups and Supabase password resets. Root causes:

1. **No Error Boundaries**: Unhandled rendering exceptions crashed the component tree silently
2. **Auth State Mismatches**: Invalid session tokens were not properly caught and cleared
3. **Unsafe Data Access**: Code accessed `null`/`undefined` properties without defensive checks, causing runtime errors
4. **Missing Null Guards**: `.map()`, `.reduce()`, and property access assumed data shapes without validation

---

## Solution: Three-Layer Fix

### 1. **ErrorBoundary Component** (`src/components/ErrorBoundary.tsx`)

**What it does:**
- Catches all rendering exceptions in the component tree
- Displays a user-friendly error page instead of a blank screen
- Logs errors in development for debugging
- Provides a "Return to Home" recovery button

**Why it helps:**
- Prevents silent failures that lead to white screens
- Gives users a clear indication something went wrong
- Provides a recovery path

**Usage:**
```typescript
// Wraps the entire App
<ErrorBoundary>
  <App />
</ErrorBoundary>
```

---

### 2. **SupabaseAuthProvider** (`src/lib/supabaseAuthContext.tsx`)

**What it does:**
- Manages Supabase authentication state lifecycle
- Listens to `auth.onAuthStateChange()` events
- Detects `SIGNED_OUT` or invalid session states
- **Automatically clears corrupted localStorage** when auth fails
- **Hard-redirects to home** to break infinite loops

**Key features:**
```typescript
// Subscribes to auth state changes
supabase.auth.onAuthStateChange((event, newSession) => {
  if (event === "SIGNED_OUT" || !newSession) {
    clearAuthState(); // Clears localStorage + redirects
    return;
  }
  // Refresh state on token refresh
});
```

**Cleared data on sign-out:**
- `sb-auth-token`, `sb-refresh-token`
- `pity_student`, `pity_fees`, `pity_payments`, `pity_credentials`, `pity_school`, `pity_slug`

---

### 3. **Defensive Data Access** (Updated Dashboards)

Applied **safe fallbacks** across all dashboard components:

#### Pattern: Optional Chaining + Nullish Coalescing

**Before (crashes on missing fields):**
```typescript
const totalFees = fees.reduce((s, f) => s + f.amount, 0);
const name = user.name.split(" ")[0]; // Crashes if user.name is undefined
```

**After (safe with defaults):**
```typescript
const totalFees = (fees ?? []).reduce((s, f) => {
  if (!f) return s;
  return s + (Number(f?.amount) || 0); // Falls back to 0 if missing
}, 0);

const name = user?.name ? user.name.split(" ")[0] : "Student"; // Safe
```

#### Pattern: Pre-check Array Elements

**Before (renders null as a row):**
```typescript
{fees.map((fee) => (
  <TableRow key={fee.id}>
    <TableCell>{fee.name}</TableCell> // Crashes if fee is null
  </TableRow>
))}
```

**After (skips null items):**
```typescript
{(fees ?? []).map((fee) => {
  if (!fee) return null; // Skip falsy items
  return (
    <TableRow key={fee?.id ?? ""}>
      <TableCell>{fee?.name ?? "—"}</TableCell>
    </TableRow>
  );
})}
```

---

## Files Modified

| File | Changes |
|------|---------|
| `src/components/ErrorBoundary.tsx` | **NEW** - Error boundary wrapper |
| `src/lib/supabaseAuthContext.tsx` | **NEW** - Auth state management |
| `src/App.tsx` | Added ErrorBoundary + SupabaseAuthProvider wrapping |
| `src/pages/AdminDashboard.tsx` | Applied defensive data access to all metrics & filtering |
| `src/pages/StudentDashboard.tsx` | Applied defensive data access to fees & payments |
| `src/pages/SchoolStudentDashboard.tsx` | Applied defensive data access + enhanced null checks |

---

## Key Changes by Dashboard

### AdminDashboard.tsx
- `totalStudents`: Safe fallback from `students?.length ?? 0`
- `totalCollected/totalFees`: Defensive `.reduce()` with item checks
- `filteredPayments/filteredStudents`: Pre-check properties before access
- All `.map()` operations include null guards

### StudentDashboard.tsx
- `fees` access: `feeStructure?.[user?.id] ?? []`
- Fee calculations: Safe `.reduce()` with property validation
- Payment list rendering: Pre-check `studentPayments` array
- Display names: Safe split with fallback `user?.name ? ... : "Student"`

### SchoolStudentDashboard.tsx
- `filteredFeeItems/filteredPayments`: Safe with null coalescing
- `totalFees/totalPaid/balance`: Comprehensive `.reduce()` guards
- Map operations: Every item checked before rendering
- Display items: Safe extraction with fallback to `"—"`

---

## Testing Recovery Steps

### 1. Simulate Auth Failure
```bash
# Clear localStorage (simulates corrupted session)
localStorage.clear()
# Refresh page
# Expected: Auto-redirect to home, no white screen
```

### 2. Simulate Null Data Response
```javascript
// In browser console
localStorage.setItem('pity_fees', JSON.stringify([null, undefined, { name: undefined }]))
window.location.reload()
// Expected: Dashboard renders safely with "—" for missing fields
```

### 3. Trigger Error Boundary
- Modify a component to throw an error
- Expected: Friendly error page appears, not white screen

---

## Deployment Checklist

- [ ] Deploy ErrorBoundary component
- [ ] Deploy SupabaseAuthProvider context
- [ ] Deploy updated App.tsx wrapping
- [ ] Deploy defensive AdminDashboard.tsx
- [ ] Deploy defensive StudentDashboard.tsx
- [ ] Deploy defensive SchoolStudentDashboard.tsx
- [ ] Test page refresh on all dashboards
- [ ] Clear browser cache/localStorage before testing
- [ ] Verify Supabase session tokens are valid

---

## Future Prevention

1. **Data Validation Layer**: Consider adding a schema validator (Zod/Yup) for Supabase responses
2. **Auth Refresh**: Implement automatic token refresh before expiry
3. **Fallback UI States**: Add skeleton loaders during data fetching
4. **Monitoring**: Log auth failures and rendering errors to an error tracking service (Sentry)
5. **E2E Tests**: Simulate network failures and invalid session states

---

## Quick Reference: Safe Data Patterns

```typescript
// Arrays
const items = (data?.items ?? []).filter(i => i); // Filter falsy
const mapped = items.map(i => i ? <Component key={i.id} /> : null);

// Objects
const value = obj?.prop?.nested ?? 'default';

// Math (with defaults)
const sum = items.reduce((s, i) => s + (Number(i?.value) || 0), 0);

// Strings
const name = user?.name ? user.name.split(" ")[0] : "Unknown";

// Conditionals
if (data) { /* safe */ }
if (data?.id) { /* safe and has id */ }
```

---

## Support

For questions or issues:
1. Check ErrorBoundary error logs in dev console
2. Verify localStorage is cleared on logout
3. Ensure Supabase session is valid (`supabase.auth.getSession()`)
4. Review browser console for null reference errors
