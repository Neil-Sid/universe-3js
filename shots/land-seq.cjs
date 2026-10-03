// steps: orbit -> 100 km -> 2 km -> 10 m for the body named in LAND_BODY (lat in LAND_LAT)
const b = process.env.LAND_BODY, lat = process.env.LAND_LAT || '20', tag = b.toLowerCase().replace(/\W/g, '')
module.exports = [
  'pre:shots/land.js', 'wait:3', `js:return orbitAt('${b}', 2.2)`, 'wait:8', `shot:land-${tag}-orbit.png`,
  `js:return landLL('${b}', ${lat}, null, 100000, -14, 90, 35)`, 'wait:2', `shot:land-${tag}-100km.png`,
  `js:return landLL('${b}', ${lat}, null, 2000, -6, 90, 35)`, 'wait:2', `shot:land-${tag}-2km.png`,
  `js:return landLL('${b}', ${lat}, null, 10, -4, 90, 35)`, 'wait:2', `shot:land-${tag}-10m.png`, 'js:return altInfo()',
]
