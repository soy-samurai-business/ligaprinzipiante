// Lógica de puntuación: Stableford neto a 9 hoyos.

export const FRONT = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export const BACK = [10, 11, 12, 13, 14, 15, 16, 17, 18];

export function holesOfNine(nine) {
  return nine === 'back' ? BACK : FRONT;
}

// Orden de juego empezando en el tee asignado (salida a tiro o por el 1).
export function playOrder(nine, startHole) {
  const holes = holesOfNine(nine);
  const i = Math.max(0, holes.indexOf(Number(startHole)));
  return [...holes.slice(i), ...holes.slice(0, i)];
}

// Hándicap de juego para 9 hoyos: mitad del hándicap con el % de aplicación de la liga.
export function playingHandicap(handicapIndex, allowancePct = 100) {
  return Math.round((Number(handicapIndex) / 2) * (allowancePct / 100));
}

// Golpes recibidos por hoyo, repartidos por el índice de dificultad (SI) dentro de los 9 hoyos.
export function strokesReceived(ph, holesInfo) {
  const res = Object.fromEntries(holesInfo.map((h) => [h.hole, 0]));
  const n = holesInfo.length;
  if (ph >= 0) {
    const bySi = [...holesInfo].sort((a, b) => a.si - b.si);
    bySi.forEach((h, r) => { res[h.hole] = Math.floor(ph / n) + (r < ph % n ? 1 : 0); });
  } else {
    // Hándicap "plus": devuelve golpes empezando por los hoyos más fáciles.
    const p = -ph;
    const bySiDesc = [...holesInfo].sort((a, b) => b.si - a.si);
    bySiDesc.forEach((h, r) => { res[h.hole] = -(Math.floor(p / n) + (r < p % n ? 1 : 0)); });
  }
  return res;
}

export function stablefordPoints(par, received, strokes) {
  if (!strokes) return 0;
  return Math.max(0, 2 + par + received - strokes);
}

// Calcula la tarjeta completa. scores: { [hole]: strokes }
export function computeCard({ nine, startHole, playingHcp }, course, scores) {
  const order = playOrder(nine, startHole);
  const info = order.map((hole) => course[hole]);
  const recv = strokesReceived(playingHcp, info);
  let gross = 0, points = 0, par = 0, thru = 0, parPlayed = 0;
  const holes = info.map((h) => {
    const strokes = scores[h.hole] ?? null;
    const pts = strokes ? stablefordPoints(h.par, recv[h.hole], strokes) : null;
    par += h.par;
    if (strokes) { gross += strokes; points += pts; thru++; parPlayed += h.par; }
    return { hole: h.hole, par: h.par, si: h.si, meters: h.meters, received: recv[h.hole], strokes, points: pts };
  });
  return { holes, gross, points, par, thru, toPar: gross - parPlayed, complete: thru === holes.length };
}

// Suma de las N mejores tarjetas validadas. results: [{ roundId, points, gross }]
export function bestOf(results, n) {
  const sorted = [...results].sort((a, b) => b.points - a.points || a.gross - b.gross);
  const counted = sorted.slice(0, n);
  return {
    total: counted.reduce((s, r) => s + r.points, 0),
    counted: new Set(counted.map((r) => r.roundId)),
    played: results.length,
    best: sorted[0]?.points ?? 0,
    all: results.reduce((s, r) => s + r.points, 0),
  };
}
