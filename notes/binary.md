# Binary and multiple stars

Every system now has a list of stars. They orbit their common barycentre on real Kepler orbits.
Catalogue multiples use published elements. Procedural stars get companions from their seed.

## Model (js/binary.js)

- A system's stars form a hierarchy of **pairs**. Each pair is `{ name, ga, gb, a, e, n, M0, plane }`.
  - `ga` and `gb` are groups of star indices.
  - `a`, `e`, `n`, `M0` and `plane` describe the relative orbit, so `kepler(pair, t)` works on it directly.
  - Inner pairs come first.
- `starOffsets(masses, pairs, t)` gives each star's offset from the barycentre. Every pair moves group a by `-r·mb/M` and group b by `+r·ma/M`. It is a pure function, also used by the arrival framing in main.js.
- `System` (system.js) now holds:
  - `sys.stars`: star bodies with `msun`, `rgb`, `companions` and `binary`.
  - `sys.pairs`: barycentre anchors with `p` (a UPos), `msun`, `name` and two orbit lines.
  - `sys.bary`: the origin UPos.
  - `sys.name`: the system name.
- `sys.star` is still the primary, so older code keeps working.
- Star bodies still have no `orbit`, so `!b.orbit` still means "star". Their positions are set by `moveStars()` at the start of `advance()`.
- **Planet hosts.** A planet spec carries `host: { star: k }` or `host: { pair: k }`.
  - The planet's `parent` is that star body, or the pair anchor for circumbinary orbits.
  - Its mean motion uses the host's mass with exact GM_SUN.
- **Lighting.** `starLight(sys, pos)` blends all stars, weighted by flux (L/d²), into the planet shader's single `u.sun` direction, `sunCol` and `light`.
  - For S-type worlds the host dominates completely.
  - For P-type worlds the blended direction sits between the two stars, which are close together on the sky.
- **Orbit lines.** Stellar orbit lines are drawn in warm amber (`placeStarOrbits`). There are two per pair, centred on the pair's barycentre.

## Generation (genSystem in system.js + `multiple()`)

- **Real systems** live in `MULTIPLES` in catalog.js. They hold the members' masses and types, plus the visual-orbit elements (P, a, e, i, Ω, ω, periastron epoch).
  - Elements are given in the plane of the sky. `skyFrame(ra, dec)` turns that frame (north, east, toward us) into galactic coordinates.
  - The systems are Alpha Centauri AB, Sirius AB, Procyon AB, 61 Cygni AB, Capella Aa/Ab and Castor. Castor is modelled as A(Aa+Ab) + B(Ba+Bb), a quadruple.
  - Proxima Centauri stays a separate star.
  - Companions such as Alpha Centauri B are no longer catalogue points. The STARS row is kept so seeds stay stable, and it is filtered out of REAL_STARS.
  - The catalogue point uses `Lsys` (the combined light).
  - Real catalogue stars never get procedural companions.
- **Procedural companions** use a separate RNG stream (`seed ^ 0x2545f491`), so planets of single stars are unchanged.
  - Multiplicity rises with mass: 0.15 for brown dwarfs, 0.25 for M, 0.45 for G, about 0.7 for O/B and giants.
  - The mass ratio is flat in 0.1 to 1, with a 15% twin excess. 8% of companions are white dwarfs. Below 0.075 M☉ a companion becomes a brown dwarf.
  - Separation is log-normal: `log10 a = 1.6 + 0.4 log10 m ± 1.1`. The median for G stars is about 41 AU (measured).
  - Pairs tighter than 0.1 AU are circular.
  - About 10% of multiples are triples (25% above 2 M☉). The third star sits 6 to 30 times further out than the inner pair.
- **Planet zone (`planetZone`).** This uses the innermost host that has room.
  - S-type planets stay inside a third of the enclosing pair's periastron.
  - Otherwise planets go P-type around the pair, starting beyond `a(2.5 + 3e)` (Holman & Wiegert). At most 5 planets are made in that case.
  - P-type planets around a real pair use that pair's orbital plane as the system frame.
  - Planet names follow their host: "Alpha Centauri A b", "X A b" for S-type, "Capella A b" for P-type.
- **Mass fix.** `massOf` used to clamp L at 0.08, so every red dwarf weighed 0.53 M☉. Below L = 0.033 it now uses L ≈ 0.23 M^2.3, which gives Proxima about 0.12 M☉.

## Hooks in shared files

- **system.js**
  - The System constructor (`buildStars`, `hostOf`).
  - `advance()` (`moveStars`).
  - `place()` (`placeStarOrbits`, plus `starLight` in place of the single-star light).
  - `genSystem` (zone, host, name, pairs, stars).
- **main.js**
  - `enterSystem`: the old static "extras" are gone.
  - `starTarget`:
    - `getPos` switches to the primary body once you are inside its system.
    - The standoff frames the system's widest pair, capped at 150 AU.
    - `arrival` comes in on the far side of the primary from the outer companion (`pairArrival`), so both stars are in view.
  - `span`, `sysSpec` (a cached genSystem), `companions`.
  - `find`: a companion name such as "Sirius B" flies to the system first, then to the star.
  - `pickFrame`: moving stars are frames within 60 radii, so the camera rides with them.
- **ui.js**
  - The system panel shows the system name and "binary G2 V + K1 V".
  - The star card has a `system` row ("binary · companion: Sirius B (white dwarf)"). Star bodies also get an `orbit` row (separation · period · pair).
  - White-dwarf spectral types display as "white dwarf".
  - Search includes companion names.
- **stars.js**: `starObject` passes on `mass` and `multiple`. CatalogStars draws `Lsys`.

## Open issues

- For very wide procedural pairs (hundreds to 3000 AU) the arrival frames only the primary, because the standoff is capped at 150 AU.
- The star glow sprite's halo is logarithmic. A white dwarf therefore looks nearly as big as its primary from tens of AU, which is how the existing sprite works.
- Castor's inner orbit orientations and some 61 Cygni elements are approximate. Periods, separations and eccentricities match the literature.
- Planets only orbit the primary or the pair containing it. Companions in wide binaries have no planets of their own.
- The README still says "31 catalogued stars".
