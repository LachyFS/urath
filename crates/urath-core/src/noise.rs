//! Hash-based value noise and fractional Brownian motion.
//!
//! All functions are deterministic and allocation-free. The hash functions
//! use wrapping 32-bit arithmetic to match the JavaScript reference
//! implementation exactly.

/// 2D integer hash returning f32 in [0, 1].
#[inline]
pub fn hash2(x: i32, y: i32) -> f32 {
    let mut h = x
        .wrapping_mul(374761393)
        .wrapping_add(y.wrapping_mul(668265263))
        .wrapping_add(1376312589);
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    (h & 0x7fffffff) as f32 / 0x7fffffff as f32
}

/// 3D integer hash returning f32 in [0, 1].
#[inline]
pub fn hash3(x: i32, y: i32, z: i32) -> f32 {
    let mut h = x
        .wrapping_mul(374761393)
        .wrapping_add(y.wrapping_mul(668265263))
        .wrapping_add(z.wrapping_mul(1274126177))
        .wrapping_add(1376312589);
    // 2246822519u32 as i32 == -2048144777i32 (matches JS `Math.imul` overflow)
    h = (h ^ (h >> 13)).wrapping_mul(-2048144777);
    h ^= h >> 16;
    (h & 0x7fffffff) as f32 / 0x7fffffff as f32
}

/// Cubic Hermite smoothstep: `t * t * (3 - 2 * t)`.
#[inline]
fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Linear interpolation.
#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// 2D interpolated value noise with smoothstep.
///
/// Returns a value in approximately [0, 1].
#[inline]
pub fn noise2d(x: f32, y: f32) -> f32 {
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    let fx = smooth(x - ix as f32);
    let fy = smooth(y - iy as f32);

    lerp(
        lerp(hash2(ix, iy), hash2(ix + 1, iy), fx),
        lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), fx),
        fy,
    )
}

/// 3D interpolated value noise with smoothstep.
///
/// Returns a value in approximately [0, 1].
#[inline]
pub fn noise3d(x: f32, y: f32, z: f32) -> f32 {
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    let iz = z.floor() as i32;
    let fx = smooth(x - ix as f32);
    let fy = smooth(y - iy as f32);
    let fz = smooth(z - iz as f32);

    lerp(
        lerp(
            lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx),
            lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx),
            fy,
        ),
        lerp(
            lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx),
            lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx),
            fy,
        ),
        fz,
    )
}

/// 2D fractional Brownian motion.
///
/// Persistence = 0.5, lacunarity = 2.0. Returns a value in [0, 1].
#[inline]
pub fn fbm2d(x: f32, y: f32, octaves: u32) -> f32 {
    if octaves == 0 {
        return 0.5;
    }
    let mut val = 0.0f32;
    let mut amp = 1.0f32;
    let mut freq = 1.0f32;
    let mut max = 0.0f32;

    for _ in 0..octaves {
        val += noise2d(x * freq, y * freq) * amp;
        max += amp;
        amp *= 0.5;
        freq *= 2.0;
    }

    val / max
}

/// 3D fractional Brownian motion.
///
/// Persistence = 0.5, lacunarity = 2.0. Returns a value in [0, 1].
#[inline]
pub fn fbm3d(x: f32, y: f32, z: f32, octaves: u32) -> f32 {
    if octaves == 0 {
        return 0.5;
    }
    let mut val = 0.0f32;
    let mut amp = 1.0f32;
    let mut freq = 1.0f32;
    let mut max = 0.0f32;

    for _ in 0..octaves {
        val += noise3d(x * freq, y * freq, z * freq) * amp;
        max += amp;
        amp *= 0.5;
        freq *= 2.0;
    }

    val / max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash2_in_range() {
        for x in -50..50 {
            for y in -50..50 {
                let v = hash2(x, y);
                assert!((0.0..=1.0).contains(&v), "hash2({x}, {y}) = {v}");
            }
        }
    }

    #[test]
    fn hash3_in_range() {
        for x in -10..10 {
            for y in -10..10 {
                for z in -10..10 {
                    let v = hash3(x, y, z);
                    assert!((0.0..=1.0).contains(&v), "hash3({x}, {y}, {z}) = {v}");
                }
            }
        }
    }

    #[test]
    fn hash2_deterministic() {
        assert_eq!(hash2(42, 99), hash2(42, 99));
        assert_eq!(hash2(-7, 13), hash2(-7, 13));
    }

    #[test]
    fn hash3_deterministic() {
        assert_eq!(hash3(1, 2, 3), hash3(1, 2, 3));
    }

    #[test]
    fn noise2d_in_range() {
        for i in 0..100 {
            let x = i as f32 * 0.37 - 20.0;
            let y = i as f32 * 0.53 + 10.0;
            let v = noise2d(x, y);
            assert!(
                (0.0..=1.0).contains(&v),
                "noise2d({x}, {y}) = {v} out of range"
            );
        }
    }

    #[test]
    fn noise3d_in_range() {
        for i in 0..100 {
            let x = i as f32 * 0.37 - 20.0;
            let y = i as f32 * 0.53 + 10.0;
            let z = i as f32 * 0.19 - 5.0;
            let v = noise3d(x, y, z);
            assert!(
                (0.0..=1.0).contains(&v),
                "noise3d({x}, {y}, {z}) = {v} out of range"
            );
        }
    }

    #[test]
    fn noise2d_at_integer_coords() {
        // At integer coordinates, noise2d should equal hash2
        // because smooth(0) = 0, so interpolation picks the corner value.
        let v = noise2d(5.0, 7.0);
        let h = hash2(5, 7);
        assert!((v - h).abs() < 1e-6, "noise2d(5,7)={v} != hash2(5,7)={h}");
    }

    #[test]
    fn fbm_zero_octaves() {
        assert_eq!(fbm2d(1.0, 2.0, 0), 0.5);
        assert_eq!(fbm3d(1.0, 2.0, 3.0, 0), 0.5);
    }

    #[test]
    fn fbm2d_single_octave_equals_noise() {
        let fbm = fbm2d(3.7, 2.1, 1);
        let noi = noise2d(3.7, 2.1);
        assert!(
            (fbm - noi).abs() < 1e-6,
            "fbm2d 1 octave = {fbm}, noise2d = {noi}"
        );
    }

    #[test]
    fn fbm2d_in_range() {
        for i in 0..100 {
            let x = i as f32 * 1.3 - 50.0;
            let y = i as f32 * 0.7 + 30.0;
            let v = fbm2d(x, y, 4);
            assert!(
                (-0.01..=1.01).contains(&v),
                "fbm2d({x}, {y}, 4) = {v} out of range"
            );
        }
    }

    #[test]
    fn fbm3d_in_range() {
        for i in 0..100 {
            let x = i as f32 * 1.3 - 50.0;
            let y = i as f32 * 0.7;
            let z = i as f32 * 0.9 - 25.0;
            let v = fbm3d(x, y, z, 3);
            assert!(
                (-0.01..=1.01).contains(&v),
                "fbm3d({x}, {y}, {z}, 3) = {v} out of range"
            );
        }
    }
}
