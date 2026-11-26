// Run-off and surroundings for this circuit, matched to aerial imagery: see src/tracks/land/README.md.
// Lap metres as labelled on the reference aerials (lap ~5114 m, driven clockwise; the start line is
// on the pit straight heading south-west, so the pits are on the driver's RIGHT along the straight
// and the main grandstand on the LEFT).
// Imagery: Rheinland-Pfalz DOP20 orthophotos, 20 cm (©GeoBasis-DE / LVermGeoRP, dl-de/by-2-0).
const GREEN = 0x2f9e6e; // the green paint strips beyond the kerbs
const strip = (paint, m, beyond) => ({ paint: [paint, paint], strip: m, pattern: 'solid', ...(beyond ? { beyond } : {}) });

export default {
  surfaces: {
    gravel: 0xd3c6aa, // pale beige Eifel gravel, almost white from above
    paint: [GREEN, GREEN],
    paintPattern: 'solid',
    widen: 0,
    width: [
      // pit straight: the Dorint hotel and ring buildings, then the main grandstand right behind the wall
      [4700, 'L', 0, 250, 9],
      [4950, 'L', 0, 170, 5],
      [0, 'L', 0, 270, 6],
      [4500, 'R', 0, 620, 4], // pit wall from the pit entry
      [0, 'R', 0, 260, 4],
      // RAVENOL-S (T1): green strip, dark asphalt, then a deep gravel bed in front of the T1 stand
      [270, 'L', 0, 70, 16],
      [340, 'L', 0, 30, 32],
      [370, 'L', 0, 30, 55],
      [400, 'L', 0, 30, 70],
      [430, 'L', 0, 30, 58],
      [460, 'L', 0, 30, 32],
      [260, 'R', 0, 200, 15], // grass on the inside, a service road beyond
      // AMG Arena (T2-T4): asphalt run-off outside, grass infield inside
      [490, 'L', 0, 170, 18],
      [460, 'R', 0, 200, 30],
      [660, 'R', 0, 200, 18], // asphalt, then a wall with the big paddock / event apron behind it
      [660, 'L', 0, 200, 25],
      [860, 'L', 0, 90, 8], // T4 exit: a strip of asphalt and the barrier
      [860, 'R', 0, 90, 15],
      // down past the T1 bed (behind a wall on the left) and over the B258 underpass
      [950, 'L', 0, 300, 8],
      [950, 'R', 0, 300, 15],
      [1250, 'L', 0, 200, 12], // grass, then the long terraces
      [1250, 'R', 0, 230, 15],
      [1450, 'L', 0, 130, 20],
      [1480, 'R', 0, 120, 45], // gravel outside the gentle left
      // PAGID Racing Kurve (T7)
      [1580, 'L', 0, 40, 25],
      [1620, 'L', 0, 40, 35],
      [1660, 'L', 0, 60, 45],
      [1720, 'L', 0, 60, 35],
      [1780, 'L', 0, 30, 18],
      [1600, 'R', 0, 200, 20],
      // the run down to the hairpin: grandstands on the left, a grass median to the return leg
      [1810, 'L', 0, 270, 18],
      [1800, 'R', 0, 280, 25],
      [2080, 'L', 0, 70, 30],
      [2080, 'R', 0, 70, 15],
      // Goodyear-Kehre (the old Dunlop-Kehre, T8): the enormous gravel bed on the outside
      [2150, 'L', 0, 40, 45],
      [2190, 'L', 0, 50, 80],
      [2240, 'L', 0, 50, 95],
      [2290, 'L', 0, 30, 60],
      [2320, 'L', 0, 160, 30],
      [2150, 'R', 0, 170, 25], // gravel inside too
      [2320, 'R', 0, 240, 25],
      [2480, 'L', 0, 80, 15],
      // Michael-Schumacher-S (T9-T10)
      [2560, 'L', 0, 160, 25],
      [2720, 'L', 0, 200, 30], // asphalt, then gravel
      [2560, 'R', 0, 40, 20],
      [2600, 'R', 0, 260, 32],
      // up to the Xiaomi Kurve (T11): walls a little way off, public roads beyond
      [2920, 'L', 0, 230, 12],
      [2860, 'R', 0, 290, 15],
      [3150, 'R', 0, 110, 18], // grass, wall, then the second paddock's asphalt
      [3150, 'L', 0, 110, 25],
      [3260, 'L', 0, 80, 20],
      [3260, 'R', 0, 80, 15],
      // BILSTEIN-Kurve (T12)
      [3340, 'L', 0, 40, 35],
      [3380, 'L', 0, 70, 47],
      [3450, 'L', 0, 50, 45],
      [3500, 'L', 0, 40, 35],
      [3540, 'L', 0, 80, 20],
      [3340, 'R', 0, 200, 20],
      // up through the woods to the Falkenbogen
      [3620, 'L', 0, 200, 10],
      [3540, 'R', 0, 280, 8],
      // Falkenbogen (T13)
      [3820, 'L', 0, 40, 30],
      [3860, 'L', 0, 60, 45],
      [3920, 'L', 0, 80, 40],
      [4000, 'L', 0, 60, 20],
      [3820, 'R', 0, 430, 30],
      [4060, 'L', 0, 190, 25],
      // Veedol-Schikane (T14-T15)
      [4250, 'R', 0, 50, 30],
      [4300, 'R', 0, 50, 45],
      [4350, 'R', 0, 60, 40],
      [4250, 'L', 0, 70, 30], // the escape road around the inside
      [4320, 'L', 0, 220, 20],
      // Hyundai N Kurve (T16): gravel outside, crossed by the link to the Nordschleife
      [4540, 'L', 0, 60, 30],
      [4600, 'L', 0, 60, 40],
      [4660, 'L', 0, 40, 25],
    ],
    paved: [
      [340, 'L', 0, 120, strip(GREEN, 5)], // T1: green strip, then dark asphalt up to the gravel
      [460, 'R', 0, 400, 'asphalt'], // AMG Arena outside
      [860, 'L', 0, 390, 'asphalt'],
      [2150, 'R', 0, 170, strip(GREEN, 4, 'grass')], // inside of the hairpin
      [2720, 'L', 0, 110, 'asphalt'], // Schumacher-S exit
      [4250, 'R', 0, 110, strip(GREEN, 4, 'grass')], // Veedol-Schikane
    ],
    // Runs with different insets overlap by 20 m (each entry's ends taper)
    traps: [
      [340, 'L', 0, 120, 25], // T1, behind the asphalt
      [1480, 'R', 0, 130, 6],
      [1580, 'L', 0, 230, 2], // PAGID Racing Kurve
      [2080, 'L', 0, 400, 2], // hairpin outside, on along the exit
      [2150, 'R', 0, 170, 5], // hairpin inside, behind the green
      [2560, 'L', 0, 170, 2], // Schumacher-S
      [2600, 'R', 0, 260, 3],
      [2810, 'L', 0, 110, 3],
      [3330, 'L', 0, 290, 1.5], // BILSTEIN-Kurve
      [3820, 'L', 0, 230, 1.5], // Falkenbogen
      [4250, 'R', 0, 160, 5], // Veedol-Schikane, behind the green
      [4540, 'L', 0, 160, 3], // Hyundai N Kurve
    ],
    sausages: [], // none clearly visible on the imagery
  },
  bridges: [
    [1240, 'foot'], [3010, 'foot'], // steel walkways over both legs at the B258 underpass
    [2370, 'gantry'],
    [4930, 'foot'], // the enclosed bridge over the pit straight
  ],
  stands: [
    [4960, 'L', 0, 154, 16], // the covered main grandstand along the pit straight
    [0, 'L', 0, 200, 16],
    [250, 'L', 0, 170, 16], // the white-roofed T1 stand
    [1060, 'L', 0, 120, 12], // the curved Mercedes-Arena stand
    [1300, 'L', 0, 350, 10], // terraces along the run to T7
    [1850, 'L', 0, 350, 12], // seats along the run down to the hairpin
    [2330, 'L', 0, 170, 10], // terraces at the hairpin exit
  ],
  kerb: { colors: [0xd0201c, 0xf2f2f2] },
  ground: 'grass',
  notes: `Nürburgring Grand-Prix-Strecke, driven clockwise. Rheinland-Pfalz DOP20 orthophotos, ~0.3 m/px
as rendered. The OSM centreline matches the asphalt to within a metre or two almost everywhere.
- Pit straight (4700 -> 0 -> 350): pits, the Start-Ziel tower and paddock on the right (north-west);
  the covered main grandstand right behind the left-hand wall, the Dorint hotel and the ring
  buildings before it. An enclosed bridge crosses the straight at about 4930.
- RAVENOL-S (T1, ~400): green strip, a band of dark asphalt, then a deep pale gravel bed in front of
  the white-roofed T1 stand and the curved Mercedes-Arena stand.
- AMG Arena (T2-T4, 460-950): asphalt run-off outside, a grass infield, the paddock / event apron
  behind the wall on the right.
- 950-1450: south past the T1 bed (behind a wall) and over the B258 underpass, with steel walkways
  over both legs (1240 and 3010). Long terraces on the left.
- PAGID Racing Kurve (T7, ~1620): deep gravel outside; gravel outside the gentle left before it too.
- 1800-2150: grandstands on the left, a wide grass median to the return leg on the right.
- Goodyear-Kehre (T8, ~2200, the old Dunlop-Kehre): the circuit's lowest point and its biggest gravel
  bed, up to ~95 m deep; green paint and gravel on the inside. Forest beyond.
- Michael-Schumacher-S (T9-T10, 2560-2900): gravel both sides, an asphalt pad on the left at the exit.
- Xiaomi Kurve (T11) and BILSTEIN-Kurve (T12): grass, then a deep gravel bed outside T12.
- 3540-3820: uphill between conifer woods; Falkenbogen (T13): deep gravel outside.
- Veedol-Schikane (T14-T15, ~4300): green strip and gravel outside the first part, an escape road
  round the inside. The circuit's highest point.
- Hyundai N Kurve (T16, ~4600): gravel outside, crossed by the link roads to the Nordschleife,
  whose start runs along the north side of the circuit.`,
};
