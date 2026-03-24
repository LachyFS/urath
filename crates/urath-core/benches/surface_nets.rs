use criterion::{Criterion, black_box, criterion_group, criterion_main};
use urath::{Chunk, ChunkNeighbors, MeshOutput, Mesher, SurfaceNetsMesher};

fn bench_empty_chunk(c: &mut Criterion) {
    let chunk = Chunk::new_default();
    let neighbors = ChunkNeighbors::empty(32);
    let mut mesher = SurfaceNetsMesher::new();
    let mut output = MeshOutput::new();

    c.bench_function("sn_mesh_empty_32", |b| {
        b.iter(|| {
            output.clear();
            mesher
                .mesh(black_box(&chunk), &neighbors, &mut output)
                .unwrap();
        })
    });
}

fn bench_solid_chunk(c: &mut Criterion) {
    let mut chunk = Chunk::new_default();
    for z in 0..32 {
        for y in 0..32 {
            for x in 0..32 {
                chunk.set(x, y, z, 1);
            }
        }
    }
    let neighbors = ChunkNeighbors::empty(32);
    let mut mesher = SurfaceNetsMesher::new();
    let mut output = MeshOutput::with_capacity(4096);

    c.bench_function("sn_mesh_solid_32", |b| {
        b.iter(|| {
            output.clear();
            mesher
                .mesh(black_box(&chunk), &neighbors, &mut output)
                .unwrap();
        })
    });
}

fn bench_surface_chunk(c: &mut Criterion) {
    let mut chunk = Chunk::new_default();
    for z in 0..32 {
        for y in 0..16 {
            for x in 0..32 {
                chunk.set(x, y, z, 1);
            }
        }
    }
    let neighbors = ChunkNeighbors::empty(32);
    let mut mesher = SurfaceNetsMesher::new();
    let mut output = MeshOutput::with_capacity(4096);

    c.bench_function("sn_mesh_surface_32", |b| {
        b.iter(|| {
            output.clear();
            mesher
                .mesh(black_box(&chunk), &neighbors, &mut output)
                .unwrap();
        })
    });
}

fn bench_noisy_surface(c: &mut Criterion) {
    let mut chunk = Chunk::new_default();
    for z in 0..32 {
        for x in 0..32 {
            let height = 8 + ((x * 7 + z * 13) % 16);
            for y in 0..height {
                chunk.set(x, y, z, 1);
            }
        }
    }
    let neighbors = ChunkNeighbors::empty(32);
    let mut mesher = SurfaceNetsMesher::new();
    let mut output = MeshOutput::with_capacity(6000);

    c.bench_function("sn_mesh_noisy_32", |b| {
        b.iter(|| {
            output.clear();
            mesher
                .mesh(black_box(&chunk), &neighbors, &mut output)
                .unwrap();
        })
    });
}

criterion_group!(
    benches,
    bench_empty_chunk,
    bench_solid_chunk,
    bench_surface_chunk,
    bench_noisy_surface
);
criterion_main!(benches);
