export type PhoneField = 'mobile_number' | 'ec_phone';

export type AllowedLike = {
  email: string;
  metadata?: Record<string, string>;
};

export type UserLike = {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  metadata?: Record<string, string>;
};

export type PhoneDuplicateMatch =
  | { kind: 'user'; user: UserLike; label: string; field: PhoneField; value: string }
  | { kind: 'allowed'; allowed: AllowedLike; label: string; field: PhoneField; value: string };

export function phoneDigits(s: string | undefined): string {
  return String(s || '').replace(/\D+/g, '');
}

// Match two phone numbers if their digit-only forms share the same last 9
// digits (UK mobile/landline length). Skip anything too short to be meaningful.
export function phoneKey(s: string | undefined): string {
  const d = phoneDigits(s);
  if (d.length < 7) return '';
  return d.length > 9 ? d.slice(-9) : d;
}

export function phoneFieldLabel(field: PhoneField): string {
  return field === 'mobile_number' ? 'mobile number' : 'emergency contact phone';
}

function fullName(u: UserLike): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

export function findPhoneDuplicate(
  raw: string,
  users: UserLike[],
  allowed: AllowedLike[],
): PhoneDuplicateMatch | null {
  const needle = phoneKey(raw);
  if (!needle) return null;
  const fields: PhoneField[] = ['mobile_number', 'ec_phone'];
  for (const u of users) {
    const m = u.metadata || {};
    for (const f of fields) {
      if (phoneKey(m[f]) === needle) {
        const name = fullName(u) || u.email || '—';
        return { kind: 'user', user: u, label: name, field: f, value: m[f] || '' };
      }
    }
  }
  for (const a of allowed) {
    const m = a.metadata || {};
    for (const f of fields) {
      if (phoneKey(m[f]) === needle) {
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || a.email;
        return { kind: 'allowed', allowed: a, label: name, field: f, value: m[f] || '' };
      }
    }
  }
  return null;
}

export function describePhoneDuplicate(
  match: PhoneDuplicateMatch,
): { title: string; body: string; cta: string } {
  const where = phoneFieldLabel(match.field);
  if (match.kind === 'user') {
    return {
      title: 'This phone number is already in use',
      body: `${match.label} (${match.user.email || '—'}) already has this number as their ${where}.`,
      cta: 'Open team member',
    };
  }
  return {
    title: 'This phone number is already in use',
    body: `${match.label} (${match.allowed.email}) already has this number as their ${where} on the allow-list.`,
    cta: 'View approved entry',
  };
}
