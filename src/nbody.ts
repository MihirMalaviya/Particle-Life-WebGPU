import { mat4, vec3 } from 'gl-matrix'
import shaders from './shaders.wgsl'

// Simulation parameters.
let numBodies;

// Shader parameters.
let workgroupSize;
let typeNum = 10;

// Controls.
let paused: Boolean = false;
let currentKey: KeyboardEvent = null;

// Render parameters.
let eyePosition: vec3;

// WebGPU objects.
let device: GPUDevice = null;
let queue: GPUQueue = null;
let computePipeline: GPUComputePipeline = null;
let renderPipeline: GPURenderPipeline = null;
let canvas: HTMLCanvasElement = null;
let canvasContext: GPUCanvasContext = null;
let positionsIn: GPUBuffer = null;
let positionsOut: GPUBuffer = null;
let velocities: GPUBuffer = null;
let types: GPUBuffer = null;
let typeAttractions: GPUBuffer = null;
let renderParams: GPUBuffer = null;
let computeBindGroup: GPUBindGroup = null;
let renderBindGroup: GPUBindGroup = null;

const init = async () => {
  // Initialize the WebGPU device.
  const powerPref = <HTMLSelectElement>document.getElementById('powerpref');
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: <GPUPowerPreference>powerPref.selectedOptions[0].value,
  });
  device = await adapter.requestDevice()
  queue = device.queue;

  // Set up the canvas context.
  canvas = <HTMLCanvasElement>document.getElementById('canvas');
  canvasContext = canvas.getContext('webgpu');
}

// Generate WGSL shader source.
function getShaders() {
  let preamble = ''
  preamble += `const kWorkgroupSize = ${workgroupSize};\n`;
  preamble += `const kNumBodies = ${numBodies};\n`;
  preamble += `const typeNum = ${typeNum};\n`;
  return preamble + shaders;
}

// Get the selected number from a drop-down menu.
function getSelectedNumber(id: string): Number {
  let list = <HTMLSelectElement>document.getElementById(id);
  return Number(list.selectedOptions[0].value);
}

const updateRenderParams = async () => {
  // Fit the canvas to the window.
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvasContext.configure({
    device: device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  // Generate the view projection matrix.
  let projectionMatrix = mat4.create();
  let viewProjectionMatrix = mat4.create();
  mat4.perspectiveZO(projectionMatrix,
    1.0, canvas.width / canvas.height, 0.1, 50.0);
  mat4.translate(viewProjectionMatrix, viewProjectionMatrix, eyePosition);
  mat4.multiply(viewProjectionMatrix, projectionMatrix, viewProjectionMatrix);

  // Write the render parameters to the uniform buffer.
  let renderParamsHost = new ArrayBuffer(4 * 4 * 4);
  let viewProjectionMatrixHost = new Float32Array(renderParamsHost);
  viewProjectionMatrixHost.set(viewProjectionMatrix);
  queue.writeBuffer(renderParams, 0, renderParamsHost);
}

function initPipelines() {
  // Reset pipelines.
  renderPipeline = null;
  computePipeline = null;

  // Update pipeline options.
  workgroupSize = getSelectedNumber("wgsize");

  // Create a uniform buffer for the render parameters.
  renderParams = device.createBuffer({
    size: 4 * 4 * 4, // sizeof(mat4x4<f32>)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: false,
  });
  updateRenderParams();

  // Create the shader module.
  const module = device.createShaderModule({ code: getShaders() });

  // Create the render pipeline.
  const positionsAttribute: GPUVertexAttribute = {
    shaderLocation: 0,
    offset: 0,
    format: 'float32x4',
  };
  const positionsLayout: GPUVertexBufferLayout = {
    attributes: [positionsAttribute],
    arrayStride: 4 * 4,
    stepMode: 'instance',
  };
  renderPipeline = device.createRenderPipeline({
    vertex: {
      module: module,
      entryPoint: 'vs_main',
      buffers: [positionsLayout],
    },
    fragment: {
      module: module,
      entryPoint: 'fs_main',
      targets: [{
        format: navigator.gpu.getPreferredCanvasFormat(),
        blend: {
          color: {
            operation: "add",
            srcFactor: "one",
            dstFactor: "one",
          },
          alpha: {
            operation: "add",
            srcFactor: "one",
            dstFactor: "one",
          },
        }
      }],
    },
    primitive: {
      frontFace: 'cw',
      cullMode: 'none',
      topology: 'triangle-list',
    },
    layout: "auto",
  });

  // Create the compute pipeline.
  computePipeline = device.createComputePipeline({
    compute: {
      module: module,
      entryPoint: 'cs_main',
    },
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" }},
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" }},
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" }},
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" }}, 
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" }}, 
          ],
        }),
      ],
    }),
  });
}

function initBodies() {
  // Create buffers for body positions and velocities.
  positionsIn = device.createBuffer({
    size: numBodies * 4 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    mappedAtCreation: true
  });
  positionsOut = device.createBuffer({
    size: numBodies * 4 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    mappedAtCreation: false
  });
  velocities = device.createBuffer({
    size: numBodies * 4 * 4,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: false
  });
  types = device.createBuffer({
    size: numBodies * 4,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true
  });
  typeAttractions = device.createBuffer({
    size: numBodies * 4,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true
  });

  // Generate initial positions on the surface of a sphere.
  // const kRadius = 1.0;

  let positions = new Float32Array(positionsIn.getMappedRange());
  let typesMapped = new Int32Array(types.getMappedRange());
  for (let i = 0; i < numBodies; i++) {
    // let longitude = 2.0 * Math.PI * Math.random();
    // let latitude = Math.acos((2.0 * Math.random() - 1.0));
    // positions[i * 4 + 0] = kRadius * Math.sin(latitude) * Math.cos(longitude);
    // positions[i * 4 + 1] = kRadius * Math.sin(latitude) * Math.sin(longitude);
    // positions[i * 4 + 2] = kRadius * Math.cos(latitude);

    positions[i * 4 + 0] = Math.random();
    positions[i * 4 + 1] = Math.random();
    positions[i * 4 + 2] = Math.random();

    positions[i * 4 + 3] = 1.0;  // size

    typesMapped[i] = i%typeNum;
  }
  positionsIn.unmap();
  types.unmap();

  let typeAttractionsMapped = new Float32Array(typeAttractions.getMappedRange());
  for (let i = 0; i < typeNum; i++) {
    for (let j = 0; j < typeNum; j++) {
      typeAttractionsMapped[i*typeNum+j] = (Math.random()*2-1)*100;
    }
  }
  typeAttractions.unmap()

}

// Render loop.
const kFpsUpdateInterval = 500;
let numFramesSinceFpsUpdate = 0;
let lastFpsUpdateTime = null;
function draw() {
  if (!computePipeline) {
    // Not ready yet.
    requestAnimationFrame(draw);
    return;
  }

  // Update the FPS counter.
  if (lastFpsUpdateTime) {
    const now = performance.now();
    const timeSinceLastLog = now - lastFpsUpdateTime;
    if (timeSinceLastLog >= kFpsUpdateInterval) {
      const fps = numFramesSinceFpsUpdate / (timeSinceLastLog / 1000.0);
      document.getElementById("fps").innerHTML = fps.toFixed(1) + ' FPS';
      lastFpsUpdateTime = performance.now();
      numFramesSinceFpsUpdate = 0;
    }
  } else {
    lastFpsUpdateTime = performance.now();
  }
  numFramesSinceFpsUpdate++;

  // Update render parameters based on key presses.
  if (currentKey) {
    let zInc = 0.025;
    if (currentKey.key == 'ArrowUp') {
      eyePosition[2] += zInc;
    } else if (currentKey.key == 'ArrowDown') {
      eyePosition[2] -= zInc;
    }
    updateRenderParams();
  }

  const commandEncoder = device.createCommandEncoder();

  // Create the bind group for the compute shader.
  computeBindGroup = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: positionsIn,
        },
      },
      {
        binding: 1,
        resource: {
          buffer: positionsOut,
        },
      },
      {
        binding: 2,
        resource: {
          buffer: velocities,
        },
      },
      {
        binding: 3,
        resource: {
          buffer: types,
        },
      },
      {
        binding: 4,
        resource: {
          buffer: typeAttractions,
        },
      },
    ],
  });

  // Create the bind group for the compute shader.
  renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: renderParams,
        },
      },
    ],
  });

  if (!paused) {
    // Set up the compute shader dispatch.
    const computePassEncoder = commandEncoder.beginComputePass();
    computePassEncoder.setPipeline(computePipeline);
    computePassEncoder.setBindGroup(0, computeBindGroup);
    computePassEncoder.dispatchWorkgroups(numBodies / workgroupSize);
    computePassEncoder.end();

    // Swap the positions buffers.
    [positionsIn, positionsOut] = [positionsOut, positionsIn];
  }

  // Set up the render pass.
  const colorTexture: GPUTexture = canvasContext.getCurrentTexture();
  const colorTextureView: GPUTextureView = colorTexture.createView();
  const colorAttachment: GPURenderPassColorAttachment = {
    view: colorTextureView,
    loadOp: "clear",
    clearValue: { r: 0, g: 0, b: 0.1, a: 1 },
    storeOp: 'store'
  };
  const renderPassEncoder = commandEncoder.beginRenderPass({
    colorAttachments: [colorAttachment],
  });
  renderPassEncoder.setPipeline(renderPipeline);
  renderPassEncoder.setViewport(0, 0, canvas.width, canvas.height, 0, 1);
  renderPassEncoder.setScissorRect(0, 0, canvas.width, canvas.height);
  renderPassEncoder.setBindGroup(0, renderBindGroup);
  renderPassEncoder.setVertexBuffer(0, positionsIn);
  renderPassEncoder.draw(6, numBodies);
  renderPassEncoder.end();

  queue.submit([commandEncoder.finish()]);

  requestAnimationFrame(draw);
}

const reset = async () => {
  // Make sure WebGPU device has been created.
  if (device == null) {
    await init();
  }

  // Reset the camera position.
  eyePosition = vec3.fromValues(-0.5, -0.5, -1.5);

  // Reset the simulation.
  numBodies = getSelectedNumber("numbodies");
  initBodies();

  // Recreate pipelines.
  initPipelines();

  paused = false;
}

function pause() {
  paused = !paused;
  document.getElementById("pause").innerText = paused ? 'Unpause' : 'Pause';
}

reset();
draw();

// Set up button onclick handlers.
document.querySelector('#reset').addEventListener('click', reset);
document.querySelector('#pause').addEventListener('click', pause);

// Automatically reset when the number of bodies is changed.
document.querySelector('#numbodies').addEventListener('change', reset);

// Automatically reset when the power preference is changed.
document.querySelector('#powerpref').addEventListener('change', () => {
  device = null;
  computePipeline = null;
  reset();
});

// Automatically rebuild the pipelines when the workgroup size is changed.
document.querySelector('#wgsize').addEventListener('change', initPipelines);

// Add an event handler to update render parameters when the window is resized.
window.addEventListener('resize', updateRenderParams);

// Handle key presses for user controls.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key == ' ') {
    pause();
  }
  currentKey = e;
});
document.addEventListener('keyup', (e: KeyboardEvent) => {
  currentKey = null;
});
