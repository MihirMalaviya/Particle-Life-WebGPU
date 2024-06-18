
// Simulation parameters.
const kDelta = .01;
const kSoftening = 0.1;
const kBeta = .5; // Constant beta value for all particles
const kRMax = .1; // Maximum interaction radius
const kFrictionHalfLife = 0.04; // Friction half-life
const kFrictionFactor = pow(0.5, kDelta / kFrictionHalfLife); // Friction factor
const PI: f32 = 3.141592653589793;

@group(0) @binding(0)
var<storage, read> positionsIn : array<vec4<f32>>;

@group(0) @binding(1)
var<storage, read_write> positionsOut : array<vec4<f32>>;

@group(0) @binding(2)
var<storage, read_write> velocities : array<vec4<f32>>;

@group(0) @binding(3)
var<storage, read> types : array<u32>;

@group(0) @binding(4)
var<storage, read> typeAttractions : array<f32>;

//fn computeForce(ipos : vec4<f32>,
//                jpos : vec4<f32>,
//                idx  : u32,
//                otherIdx : u32
//                ) -> vec4<f32> {
//  let d = vec4((jpos - ipos).xyz, 0);
//  let distSq = d.x*d.x + d.y*d.y + d.z*d.z + kSoftening*kSoftening;
//  let dist   = inverseSqrt(distSq);
//  let coeff  = jpos.w * (dist*dist*dist);
//
//  let attraction = typeAttractions[types[idx]*2 + types[otherIdx]];
//  if (dist>5.) { return d*0; }
//
//  return coeff * d * attraction;
//}

fn computeForce(ipos : vec4<f32>,
                jpos : vec4<f32>,
                idx  : u32,
                otherIdx : u32
                ) -> vec4<f32> {
  let d = vec4((jpos - ipos).xyz, 0);
  let distSq = d.x*d.x + d.y*d.y + d.z*d.z;
  let dist   = sqrt(distSq);
  let coeff  = jpos.w * (dist*dist*dist);

  let attraction = typeAttractions[types[idx]*typeNum + types[otherIdx]];
  var force = vec4(0.0);

  let rNorm = dist / kRMax;
  if (rNorm < 0.1) {
    force = -3.0 * d * 10.;
  } else 
  if (rNorm < kBeta) {
    force = -(kBeta - rNorm) / ((3.0 * rNorm) / kBeta) * d * 10.;
  } else if (rNorm > kBeta && rNorm < 1.0) {
    force = attraction * (1.0 - abs(2.0 * rNorm - 1.0 - kBeta) / (1.0 - kBeta)) * d;
  } else {
    force = 0 * d;
  }

  return force*2.;
}


fn clampMagnitude(v: vec4<f32>, maxMagnitude: f32) -> vec4<f32> {
    // Calculate the squared magnitude of the vector
    let sqrMagnitude = dot(v, v);

    // Check if the squared magnitude exceeds the squared maximum magnitude
    if (sqrMagnitude > maxMagnitude * maxMagnitude) {
        // If so, normalize the vector and scale it by the maximum magnitude
        return v * (maxMagnitude / sqrt(sqrMagnitude));
    } else {
        // Otherwise, return the original vector
        return v;
    }
}

@compute @workgroup_size(kWorkgroupSize)
fn cs_main(
  @builtin(global_invocation_id) gid : vec3<u32>,
  ) {
  let idx = gid.x;
  let pos = positionsIn[idx];

  // Compute force.
  var force = vec4(0.0);
  for (var i = 0; i < kNumBodies; i++) {
    force = force + computeForce(pos, positionsIn[i], idx, bitcast<u32>(i));
  }

  // // Update velocity.
  // var velocity = velocities[idx];
  // velocity = velocity + force * kDelta;
  // // velocity = clampMagnitude(velocity, 10.);
  // // velocity = velocity * kFrictionFactor
  // velocities[idx] = velocity;

  var velocity = velocities[idx];
  velocity = velocity * kFrictionFactor; // Apply friction
  velocity = velocity + force * kDelta * kRMax;
  velocities[idx] = velocity;

  // Update position.
  positionsOut[idx] = pos + velocity * kDelta;

  positionsOut[idx].x = (positionsOut[idx].x + 1.) % 1.;
  positionsOut[idx].y = (positionsOut[idx].y + 1.) % 1.;
  positionsOut[idx].z = (positionsOut[idx].z + 1.) % 1.;
}

struct RenderParams {
  viewProjectionMatrix : mat4x4<f32>
}

@group(0) @binding(0)
var<uniform> renderParams : RenderParams;

struct VertexOut {
  @builtin(position) position : vec4<f32>,
  @location(0) positionInQuad : vec2<f32>,
  @location(1) @interpolate(flat) color : vec3<f32>,
}

fn cosineColor(x: f32) -> vec3<f32> {
    // Calculate the cosine values based on the given formulas
    let red = cos((x) * 2.0 * PI);           // cos(x * 2π)
    let green = cos((x + 1.0/3.0) * 2.0 * PI); // cos((x + 1/3) * 2π)
    let blue = cos((x + 2.0/3.0) * 2.0 * PI);  // cos((x + 2/3) * 2π)

    // Return the vec3 color
    return vec3<f32>(red, green, blue);
}

@vertex
fn vs_main(
  @builtin(instance_index) idx : u32,
  @builtin(vertex_index) vertex : u32,
  @location(0) position : vec4<f32>,
  ) -> VertexOut {

  let kPointRadius = 0.005;
  let vertexOffsets = array<vec2<f32>, 6>(
    vec2( 1.0, -1.0),
    vec2(-1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0),
    vec2( 1.0, -1.0),
  );
  let offset = vertexOffsets[vertex];

  var out : VertexOut;
  out.position = renderParams.viewProjectionMatrix *
    vec4(position.xy + offset * kPointRadius, position.zw);
  out.positionInQuad = offset;
  
  // if ((idx % typeNum) == 0){
  //   out.color = vec3(1, 0, 0);}
  // else if ((idx % typeNum) == 1){
  //   out.color = vec3(0, 0, 1);}
  // else {
  //   out.color = vec3(0, 1, 0);}

  out.color = cosineColor(f32(idx) / typeNum);

  return out;
}

@fragment
fn fs_main(
  @builtin(position) position : vec4<f32>,
  @location(0) positionInQuad : vec2<f32>,
  @location(1) @interpolate(flat) color : vec3<f32>,
  ) -> @location(0) vec4<f32> {
  // Calculate the normalized distance from this fragment to the quad center.
  let distFromCenter = length(positionInQuad);

  // Discard fragments that are outside the circle.
  if (distFromCenter > .5) {
    discard;
  }

  let intensity = 1. - distFromCenter;
  return vec4(color * intensity, 1.);
  
  // return vec4(color, 1);
}
