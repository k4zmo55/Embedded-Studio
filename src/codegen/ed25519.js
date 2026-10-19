// @ts-check
/**
 * ES-304: bootloader için Ed25519 imza doğrulaması (RFC 8032) ve SHA-512 (FIPS 180-4) — C kaynağı.
 * Alan aritmetiği TweetNaCl'deki 16 × 16 bit gösterime dayanır (kamu malı). Sabitler (eğri sabiti d, √-1,
 * taban noktası, SHA-512 K ve H) ezberden değil, burada BigInt ile hesaplanıp koda yazılır.
 * Doğrulama yalnızca açık veriyle çalışır; sabit zamanlı olması gerekmez ama TweetNaCl'deki gibi bırakıldı.
 */

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function pow(b, e, m) {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}
const mod = (a) => ((a % P) + P) % P;
const inv = (a) => pow(a, P - 2n, P);

/** Eğri sabitleri */
function constants() {
  const d = mod(-121665n * inv(121666n));
  const I = pow(2n, (P - 1n) / 4n, P);
  const y = mod(4n * inv(5n));
  const u = mod((y * y - 1n) * inv(d * y * y + 1n));
  let x = pow(u, (P + 3n) / 8n, P);
  if (mod(x * x - u) !== 0n) x = mod(x * I);
  if (x & 1n) x = P - x;
  return { D: d, D2: mod(2n * d), I, X: x, Y: y };
}

/** Alan elemanı → 16 adet 16 bitlik uzuv (küçük uçlu) */
const limbs = (v) => Array.from({ length: 16 }, (_, i) => '0x' + ((v >> BigInt(16 * i)) & 0xffffn).toString(16).padStart(4, '0'));

function iroot(n, k) {
  // Tamsayı k. kök (Newton)
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
  for (;;) {
    const y = ((BigInt(k) - 1n) * x + n / x ** BigInt(k - 1)) / BigInt(k);
    if (y >= x) return x;
    x = y;
  }
}

function primes(n) {
  const out = [];
  for (let c = 2; out.length < n; c++) if (out.every((p) => c % p)) out.push(c);
  return out;
}

/** SHA-512 sabitleri: K = ilk 80 asalın küp köklerinin, H = ilk 8 asalın karekökünün kesirli kısmı (64 bit) */
function shaConstants() {
  const M = (1n << 64n) - 1n;
  const ps = primes(80).map(BigInt);
  return {
    K: ps.map((p) => iroot(p << 192n, 3) & M),
    H: ps.slice(0, 8).map((p) => iroot(p << 128n, 2) & M)
  };
}

const u64 = (v) => '0x' + v.toString(16).padStart(16, '0') + 'ULL';
const rows = (items, per, ind = '  ') => {
  const out = [];
  for (let i = 0; i < items.length; i += per) out.push(ind + items.slice(i, i + per).join(', ') + ',');
  return out.join('\n').replace(/,$/, '');
};

function header() {
  return `/* Embedded Studio (ES-304): SHA-512 ve Ed25519 imza doğrulaması (RFC 8032). Yalnızca doğrulama; imzalama
 * bilgisayarda, özel anahtarla yapılır (Embedded Studio). */
#ifndef ES_ED25519_H
#define ES_ED25519_H

#include <stdint.h>

typedef struct {
  uint64_t h[8];
  uint64_t len;     /* toplam bayt */
  uint8_t buf[128];
  uint32_t n;       /* buf'taki bayt */
} es_sha512_t;

void es_sha512_init(es_sha512_t *s);
void es_sha512_update(es_sha512_t *s, const void *data, uint32_t n);
void es_sha512_final(es_sha512_t *s, uint8_t out[64]);

/* İmza doğrulaması. hram = SHA-512(R || A || M): ileti büyük olduğu için çağıran akış hâlinde hesaplar
 * (R = sig[0..32], A = açık anahtar). 0: geçerli, -1: geçersiz. */
int es_ed25519_verify(const uint8_t sig[64], const uint8_t pk[32], const uint8_t hram[64]);

/* Uzun hesaplarda çağrılır (watchdog). Tanımı es_boot_core.c'de. */
void es_ed25519_yield(void);

#endif /* ES_ED25519_H */
`;
}

function source() {
  const c = constants();
  const s = shaConstants();
  const lb = Array.from({ length: 32 }, (_, i) => '0x' + ((L >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0'));
  return `/* Embedded Studio (ES-304): SHA-512 ve Ed25519 doğrulaması. Alan aritmetiği TweetNaCl'den (kamu malı) uyarlandı.
 * Her "Kod Üret"te yeniden yazılır. Sabitler eklentide hesaplanır; test: test/boot-core.js (Node.js imzalarıyla). */
#include <string.h>
#include "es_ed25519.h"

/* ---------------------------------------------------------------- SHA-512 */
static const uint64_t K[80] = {
${rows(s.K.map(u64), 3)}
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

static uint64_t be64(const uint8_t *p)
{
  uint64_t v = 0;
  for (int i = 0; i < 8; i++) v = (v << 8) | p[i];
  return v;
}

static void block(uint64_t st[8], const uint8_t *p)
{
  uint64_t w[16], a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (int i = 0; i < 16; i++) w[i] = be64(p + 8 * i);
  for (int i = 0; i < 80; i++) {
    if (i >= 16) {
      uint64_t x = w[(i + 1) & 15], y = w[(i + 14) & 15];
      w[i & 15] += (ROR(x, 1) ^ ROR(x, 8) ^ (x >> 7)) + (ROR(y, 19) ^ ROR(y, 61) ^ (y >> 6)) + w[(i + 9) & 15];
    }
    uint64_t t1 = h + (ROR(e, 14) ^ ROR(e, 18) ^ ROR(e, 41)) + ((e & f) ^ (~e & g)) + K[i] + w[i & 15];
    uint64_t t2 = (ROR(a, 28) ^ ROR(a, 34) ^ ROR(a, 39)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  st[0] += a; st[1] += b; st[2] += c; st[3] += d; st[4] += e; st[5] += f; st[6] += g; st[7] += h;
}

void es_sha512_init(es_sha512_t *s)
{
  static const uint64_t H[8] = {
${rows(s.H.map(u64), 2, '    ')}
  };
  memcpy(s->h, H, sizeof H);
  s->len = 0;
  s->n = 0;
}

void es_sha512_update(es_sha512_t *s, const void *data, uint32_t n)
{
  const uint8_t *p = (const uint8_t *)data;
  s->len += n;
  while (n) {
    uint32_t k = 128U - s->n;
    if (k > n) k = n;
    memcpy(s->buf + s->n, p, k);
    s->n += k;
    p += k;
    n -= k;
    if (s->n == 128U) {
      block(s->h, s->buf);
      s->n = 0;
    }
  }
}

void es_sha512_final(es_sha512_t *s, uint8_t out[64])
{
  uint64_t bits = s->len << 3;
  s->buf[s->n++] = 0x80U;
  if (s->n > 112U) {
    memset(s->buf + s->n, 0, 128U - s->n);
    block(s->h, s->buf);
    s->n = 0;
  }
  memset(s->buf + s->n, 0, 128U - s->n);
  s->buf[119] = (uint8_t)(s->len >> 61);
  for (int i = 0; i < 8; i++) s->buf[127 - i] = (uint8_t)(bits >> (8 * i));
  block(s->h, s->buf);
  for (int i = 0; i < 8; i++)
    for (int j = 0; j < 8; j++) out[8 * i + j] = (uint8_t)(s->h[i] >> (56 - 8 * j));
}

/* ---------------------------------------------------------------- GF(2^255 - 19) */
typedef int64_t gf[16];

static const gf gf0 = { 0 };
static const gf gf1 = { 1 };
static const gf D2 = { ${limbs(c.D2).join(', ')} };
static const gf D = { ${limbs(c.D).join(', ')} };
static const gf X = { ${limbs(c.X).join(', ')} };
static const gf Y = { ${limbs(c.Y).join(', ')} };
static const gf I = { ${limbs(c.I).join(', ')} };
/* Grup mertebesi L = 2^252 + 27742317777372353535851937790883648493 (küçük uçlu) */
static const int64_t Lb[32] = {
${rows(lb, 16)}
};

static void set25519(gf r, const gf a)
{
  for (int i = 0; i < 16; i++) r[i] = a[i];
}

static void car25519(gf o)
{
  for (int i = 0; i < 16; i++) {
    o[i] += (int64_t)1 << 16;
    int64_t c = o[i] >> 16;
    if (i < 15) o[i + 1] += c - 1;
    else o[0] += 38 * (c - 1);
    o[i] -= c * 65536;
  }
}

static void sel25519(gf p, gf q, int b)
{
  int64_t c = ~((int64_t)b - 1);
  for (int i = 0; i < 16; i++) {
    int64_t t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

static void pack25519(uint8_t *o, const gf n)
{
  gf m, t;
  set25519(t, n);
  car25519(t);
  car25519(t);
  car25519(t);
  for (int j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (int i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    int b = (int)((m[15] >> 16) & 1);
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (int i = 0; i < 16; i++) {
    o[2 * i] = (uint8_t)(t[i] & 0xff);
    o[2 * i + 1] = (uint8_t)(t[i] >> 8);
  }
}

static int neq25519(const gf a, const gf b)
{
  uint8_t c[32], d[32];
  pack25519(c, a);
  pack25519(d, b);
  return memcmp(c, d, 32) != 0;
}

static uint8_t par25519(const gf a)
{
  uint8_t d[32];
  pack25519(d, a);
  return d[0] & 1U;
}

static void unpack25519(gf o, const uint8_t *n)
{
  for (int i = 0; i < 16; i++) o[i] = n[2 * i] + ((int64_t)n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

static void A(gf o, const gf a, const gf b)
{
  for (int i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

static void Z(gf o, const gf a, const gf b)
{
  for (int i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

static void M(gf o, const gf a, const gf b)
{
  int64_t t[31];
  for (int i = 0; i < 31; i++) t[i] = 0;
  for (int i = 0; i < 16; i++)
    for (int j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  for (int i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (int i = 0; i < 16; i++) o[i] = t[i];
  car25519(o);
  car25519(o);
}

static void S(gf o, const gf a) { M(o, a, a); }

static void inv25519(gf o, const gf i)
{
  gf c;
  set25519(c, i);
  for (int a = 253; a >= 0; a--) {
    S(c, c);
    if (a != 2 && a != 4) M(c, c, i);
  }
  set25519(o, c);
}

static void pow2523(gf o, const gf i)
{
  gf c;
  set25519(c, i);
  for (int a = 250; a >= 0; a--) {
    S(c, c);
    if (a != 1) M(c, c, i);
  }
  set25519(o, c);
}

/* ---------------------------------------------------------------- nokta işlemleri (genişletilmiş koordinatlar) */
static void add(gf p[4], gf q[4])
{
  gf a, b, c, d, t, e, f, g, h;
  Z(a, p[1], p[0]);
  Z(t, q[1], q[0]);
  M(a, a, t);
  A(b, p[0], p[1]);
  A(t, q[0], q[1]);
  M(b, b, t);
  M(c, p[3], q[3]);
  M(c, c, D2);
  M(d, p[2], q[2]);
  A(d, d, d);
  Z(e, b, a);
  Z(f, d, c);
  A(g, d, c);
  A(h, b, a);
  M(p[0], e, f);
  M(p[1], h, g);
  M(p[2], g, f);
  M(p[3], e, h);
}

static void cswap(gf p[4], gf q[4], int b)
{
  for (int i = 0; i < 4; i++) sel25519(p[i], q[i], b);
}

static void pack(uint8_t *r, gf p[4])
{
  gf tx, ty, zi;
  inv25519(zi, p[2]);
  M(tx, p[0], zi);
  M(ty, p[1], zi);
  pack25519(r, ty);
  r[31] ^= (uint8_t)(par25519(tx) << 7);
}

static void scalarmult(gf p[4], gf q[4], const uint8_t *s)
{
  set25519(p[0], gf0);
  set25519(p[1], gf1);
  set25519(p[2], gf1);
  set25519(p[3], gf0);
  for (int i = 255; i >= 0; --i) {
    int b = (s[i / 8] >> (i & 7)) & 1;
    cswap(p, q, b);
    add(q, p);
    add(p, p);
    cswap(p, q, b);
    if ((i & 31) == 0) es_ed25519_yield();
  }
}

static void scalarbase(gf p[4], const uint8_t *s)
{
  gf q[4];
  set25519(q[0], X);
  set25519(q[1], Y);
  set25519(q[2], gf1);
  M(q[3], X, Y);
  scalarmult(p, q, s);
}

/* x mod L; x: 64 adet bayt değeri */
static void modL(uint8_t *r, int64_t x[64])
{
  int64_t carry;
  int i, j;
  for (i = 63; i >= 32; --i) {
    carry = 0;
    for (j = i - 32; j < i - 12; ++j) {
      x[j] += carry - 16 * x[i] * Lb[j - (i - 32)];
      carry = (x[j] + 128) >> 8;
      x[j] -= carry * 256;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) {
    x[j] += carry - (x[31] >> 4) * Lb[j];
    carry = x[j] >> 8;
    x[j] &= 255;
  }
  for (j = 0; j < 32; j++) x[j] -= carry * Lb[j];
  for (i = 0; i < 32; i++) {
    x[i + 1] += x[i] >> 8;
    r[i] = (uint8_t)(x[i] & 255);
  }
}

/* A'yı açar ve negatifini verir (-A) */
static int unpackneg(gf r[4], const uint8_t p[32])
{
  gf t, chk, num, den, den2, den4, den6;
  set25519(r[2], gf1);
  unpack25519(r[1], p);
  S(num, r[1]);
  M(den, num, D);
  Z(num, num, r[2]);
  A(den, r[2], den);
  S(den2, den);
  S(den4, den2);
  M(den6, den4, den2);
  M(t, den6, num);
  M(t, t, den);
  pow2523(t, t);
  M(t, t, num);
  M(t, t, den);
  M(t, t, den);
  M(r[0], t, den);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], I);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) return -1;
  if (par25519(r[0]) == (p[31] >> 7)) Z(r[0], gf0, r[0]);
  M(r[3], r[0], r[1]);
  return 0;
}

/* S < L (imza değiştirilebilirliğine karşı, RFC 8032 5.1.7) */
static int scalar_ok(const uint8_t *s)
{
  for (int i = 31; i >= 0; i--) {
    if (s[i] < Lb[i]) return 1;
    if (s[i] > Lb[i]) return 0;
  }
  return 0;
}

int es_ed25519_verify(const uint8_t sig[64], const uint8_t pk[32], const uint8_t hram[64])
{
  uint8_t t[32], h[32];
  int64_t x[64];
  gf p[4], q[4];
  if (!scalar_ok(sig + 32)) return -1;
  if (unpackneg(q, pk)) return -1;
  for (int i = 0; i < 64; i++) x[i] = hram[i];
  modL(h, x);
  scalarmult(p, q, h);     /* p = h · (-A) */
  scalarbase(q, sig + 32); /* q = S · B */
  add(p, q);               /* S·B - h·A == R olmalı */
  pack(t, p);
  return memcmp(sig, t, 32) == 0 ? 0 : -1;
}
`;
}

module.exports = { header, source, constants, shaConstants, P, L };
