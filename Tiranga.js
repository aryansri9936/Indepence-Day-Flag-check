(() => {
  
  const fileInput = document.getElementById('file');
  if (fileInput) {
    const runBtn = document.getElementById('run');
    const downloadBtn = document.getElementById('download');
    const reportEl = document.getElementById('report');
    const detailsEl = document.getElementById('details');
    const metaEl = document.getElementById('meta');
    const canvas = document.getElementById('canvas');
    const maskCanvas = document.getElementById('mask');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

      const REF = {
    saffron: [255,153,51],
    white:   [255,255,255],
    green:   [19,136,8]
  };

  const CFG = {
    aspectRel: 0.01,
    colorPct:  5,
    stripeRel: 0.01,
    centerPx:  2,
    expectedSpokes: 24,
    
    profileSteps: 1440,       
    radialSamplesMin: 48,     
    annulusInner: 0.45,        
    annulusOuter: 0.95,
   
    kMin: 20,
    kMax: 28,
    // peak picking
    minSepFactor: 0.7,       
    prominenceStd: 0.45,      
  };

  function rgbDeviationPct(a,b) {
    const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2];
    const d=Math.sqrt(dr*dr+dg*dg+db*db);
    const max=Math.sqrt(255*255*3);
    return (d/max)*100;
  }
  function meanColor({x,y,w,h}) {
    const id=ctx.getImageData(x,y,w,h).data;
    let r=0,g=0,b=0,n=w*h;
    for(let i=0;i<id.length;i+=4){r+=id[i];g+=id[i+1];b+=id[i+2];}
    return [r/n,g/n,b/n];
  }

 
  function rgbToHsv(r,g,b){
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    const v=max, d=max-min;
    const s=max===0?0:d/max;
    let h=0;
    if (d!==0){
      switch(max){
        case r: h=(g-b)/d + (g<b?6:0); break;
        case g: h=(b-r)/d + 2; break;
        case b: h=(r-g)/d + 4; break;
      }
      h/=6;
    }
    return [h,s,v];
  }
  function isBlueFamily(px){
    const [h,s,v]=rgbToHsv(px[0],px[1],px[2]);
    const hue=h*360;
   
    const hueOk = hue>=195 && hue<=265;
    const satOk = s>=0.15;         
    const valOk = v>=0.08 && v<=0.95; 
    return hueOk && satOk && valOk;
  }

  function loadImageFile(file){
    return new Promise((resolve,reject)=>{
      const fr=new FileReader();
      fr.onload=()=>{ const img=new Image(); img.onload=()=>resolve(img); img.onerror=reject; img.src=fr.result; };
      fr.onerror=reject;
      fr.readAsDataURL(file);
    });
  }
  function paintToCanvas(img) {
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    maskCtx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
  }

  
  function stripeInfo(){
    const H=canvas.height;
    const y1=Math.round(H/3), y2=Math.round(2*H/3);
    return { y1, y2, topH:y1, midH:y2-y1, botH:H-y2, ratios:[1/3,1/3,1/3] };
  }

  
  function chakraMaskAndGeometry(whiteBand){
    const {y,h}=whiteBand; const W=canvas.width,H=canvas.height;
    const id=ctx.getImageData(0,0,W,H).data;
    const mId=maskCtx.createImageData(W,H);

    const pts=[]; 
    for(let yy=y; yy<y+h; yy++){
      for(let x=0; x<W; x++){
        const idx=(yy*W+x)*4;
        const px=[id[idx],id[idx+1],id[idx+2]];
        const keep=isBlueFamily(px);
        mId.data[idx]   = keep?80:0;
        mId.data[idx+1] = keep?120:0;
        mId.data[idx+2] = keep?255:0;
        mId.data[idx+3] = keep?180:0;
        if(keep) pts.push([x,yy]);
      }
    }
    maskCtx.putImageData(mId,0,0);
    if(!pts.length) return null;

    
    let sx=0, sy=0; for(const p of pts){ sx+=p[0]; sy+=p[1]; }
    const cx = sx/pts.length, cy = sy/pts.length;

   
    const steps = 720;
    const rayR = [];
    for(let a=0;a<steps;a++){
      const ang = a * 2*Math.PI / steps, c=Math.cos(ang), s=Math.sin(ang);
      let r=0, last=0;
      const rMax = Math.min(W,H); // safe bound
      for(r=0; r<rMax; r+=1){
        const x=Math.round(cx + r*c), y2=Math.round(cy + r*s);
        if(x<0||y2<0||x>=W||y2>=H) break;
        const idx=(y2*W+x)*4;
        const px=[id[idx],id[idx+1],id[idx+2]];
        if(isBlueFamily(px)) last = r;
      }
      if (last>0) rayR.push(last);
    }
    if (!rayR.length) return null;
    rayR.sort((a,b)=>a-b);
    const radius = rayR[Math.floor(rayR.length/2)]; // median

    return { cx, cy, radius, sampleCount: pts.length };
  }

  
  function angularProfile(center, radius){
    const {cx,cy}=center;
    const W=canvas.width,H=canvas.height;
    const id=ctx.getImageData(0,0,W,H).data;

    const N = CFG.profileSteps;
    const inner = radius * CFG.annulusInner;
    const outer = radius * CFG.annulusOuter;
    const radialSamples = Math.max(CFG.radialSamplesMin, Math.floor((outer-inner)));
    const prof = new Array(N).fill(0);

    for(let a=0; a<N; a++){
      const ang = a * 2*Math.PI / N, c=Math.cos(ang), s=Math.sin(ang);
      let blue=0, tot=0;
      for(let i=0;i<radialSamples;i++){
        const t = inner + (outer-inner) * (i/(radialSamples-1));
        const x=Math.round(cx + t*c), y=Math.round(cy + t*s);
        if(x<0||x>=W||y<0||y>=H) continue;
        const idx=(y*W + x)*4;
        const px=[id[idx],id[idx+1],id[idx+2]];
        if(isBlueFamily(px)) blue++;
        tot++;
      }
      prof[a] = tot ? blue/tot : 0;
    }

   
    const K = Math.max(3, Math.floor(N/180)); // ~2° window
    const base = new Array(N).fill(0);
    for(let i=0;i<N;i++){
      let s=0,cnt=0;
      for(let j=-K;j<=K;j++){
        const t=(i+j+N)%N; s+=prof[t]; cnt++;
      }
      base[i]=s/cnt;
    }
    const x = prof.map((v,i)=> Math.max(0, v - base[i])); 

   
    const y = new Array(N).fill(0);
    for(let i=0;i<N;i++){
      const im1=(i-1+N)%N, ip1=(i+1)%N;
      y[i] = (x[im1] - 2*x[i] + x[ip1]) * (-1); 
    }

    return { prof: y, raw: prof };
  }

  
  function dftBestK(arr, kMin, kMax){
    const N=arr.length;
    const mean = arr.reduce((a,b)=>a+b,0)/N;
    const x = arr.map(v=>v-mean);
    let bestK=kMin, bestMag=-1, mags=[];
    for(let k=kMin;k<=kMax;k++){
      let re=0, im=0;
      for(let n=0;n<N;n++){
        const ang = -2*Math.PI*k*n/N;
        re += x[n]*Math.cos(ang);
        im += x[n]*Math.sin(ang);
      }
      const mag=Math.hypot(re,im);
      mags.push({k,mag});
      if(mag>bestMag){ bestMag=mag; bestK=k; }
    }
    mags.sort((a,b)=>b.mag-a.mag);
    const significance = mags[1] ? mags[0].mag / (mags[1].mag+1e-9) : 99;
    return {k:bestK, significance:+significance.toFixed(2)};
  }

  
  function findPeaksCircular(arr, expectedK){
    const N=arr.length;
    const mean=arr.reduce((a,b)=>a+b,0)/N;
    const std=Math.sqrt(arr.reduce((s,v)=>s+(v-mean)*(v-mean),0)/N);
    const thr = mean + CFG.prominenceStd*std;

   
    const cand=[];
    for(let i=0;i<N;i++){
      const im1=(i-1+N)%N, ip1=(i+1)%N;
      if(arr[i]>thr && arr[i]>=arr[im1] && arr[i]>=arr[ip1]) cand.push(i);
    }
    if(!cand.length) return [];

    
    const sep = Math.floor(N/expectedK * CFG.minSepFactor);
    const kept=[];
    for(const idx of cand){
      if(!kept.length){ kept.push(idx); continue; }
      const last=kept[kept.length-1];
      if(((idx-last+N)%N) < sep){
      
        if(arr[idx]>arr[last]) kept[kept.length-1]=idx;
      } else {
        kept.push(idx);
      }
    }

    if(kept.length>1){
      const gap = (kept[0] - kept[kept.length-1] + N) % N;
      if (gap < sep) {
        if (arr[kept[0]] >= arr[kept[kept.length-1]]) kept.pop();
        else kept.shift();
      }
    }

    return kept.sort((a,b)=>a-b);
  }


  function fusePairsIfNeeded(indices, N){
    if (indices.length >= 2*CFG.expectedSpokes - 2 &&
        indices.length <= 2*CFG.expectedSpokes + 4) {
      const fused=[];
      for(let i=0;i<indices.length;i+=2){
        const a=indices[i], b=indices[(i+1)%indices.length];
        const mid = Math.round((a + ((b-a+N)%N)/2)) % N;
        fused.push(mid);
      }
      return fused;
    }
    return indices;
  }

  function estimateSpokes(center, radius){
    const {prof, raw} = angularProfile(center, radius);
    const N = prof.length;

    const dft = dftBestK(prof, CFG.kMin, CFG.kMax);
    const idx = findPeaksCircular(prof, dft.k);
    const idx2 = fusePairsIfNeeded(idx, N);

    
    const toDeg = (i)=> i*360/N;
    return {
      detected: idx2.length,
      angles: idx2.map(toDeg),
      dft_k: dft.k,
      dft_significance: dft.significance,
      profile_max: Math.max(...prof).toFixed(3),
      profile_mean: (prof.reduce((a,b)=>a+b,0)/N).toFixed(3)
    };
  }


  function validate(){
    const W=canvas.width, H=canvas.height;
    const aspect_ratio = {
      status: Math.abs(W/H - 1.5) <= 1.5*CFG.aspectRel ? "pass":"fail",
      actual: +(W/H).toFixed(4)
    };

    const sb = stripeInfo();
    const stripe_proportion = {
      status: "pass",
      top:+sb.ratios[0].toFixed(4),
      middle:+sb.ratios[1].toFixed(4),
      bottom:+sb.ratios[2].toFixed(4)
    };

    const colors = {};
    const topDev = rgbDeviationPct(meanColor({x:0,y:0,w:W,h:sb.topH}), REF.saffron);
    const midDev = rgbDeviationPct(meanColor({x:0,y:sb.topH,w:W,h:sb.midH}), REF.white);
    const botDev = rgbDeviationPct(meanColor({x:0,y:sb.topH+sb.midH,w:W,h:sb.botH}), REF.green);
    colors.saffron = { status: topDev<=CFG.colorPct ? "pass":"fail", deviation:`${topDev.toFixed(2)}%` };
    colors.white   = { status: midDev<=CFG.colorPct ? "pass":"fail", deviation:`${midDev.toFixed(2)}%` };
    colors.green   = { status: botDev<=CFG.colorPct ? "pass":"fail", deviation:`${botDev.toFixed(2)}%` };

    const whiteBand = { x:0, y:sb.topH, w:W, h:sb.midH };
    const geom = chakraMaskAndGeometry(whiteBand);

    let chakra_position, chakra_size, chakra_spokes;
    const notes = [];

    if (!geom) {
      chakra_position = { status:"fail", reason:"No blue-family region detected in white band" };
      chakra_size     = { status:"fail", reason:"Chakra not found" };
      chakra_spokes   = { status:"fail", detected:0 };
    } else {
      const {cx,cy,radius} = geom;
      const idealX = W/2, idealY = whiteBand.y + whiteBand.h/2;
      const offX = +(cx - idealX).toFixed(1);
      const offY = +(cy - idealY).toFixed(1);
      const centered = Math.abs(offX)<=CFG.centerPx && Math.abs(offY)<=CFG.centerPx;
      chakra_position = { status:centered?"pass":"fail", offset_x:`${offX}px`, offset_y:`${offY}px` };

      const expectedDiameter = 0.75*whiteBand.h;
      const actualDiameter = 2*radius;
      const sizePass = Math.abs(actualDiameter-expectedDiameter) <= expectedDiameter*0.05;
      chakra_size = {
        status: sizePass?"pass":"fail",
        expected:+expectedDiameter.toFixed(2),
        actual:+actualDiameter.toFixed(2)
      };

      const spokes = estimateSpokes({cx,cy}, radius);
      const ok = (spokes.detected === CFG.expectedSpokes);
      chakra_spokes = {
        status: ok?"pass":"fail",
        detected: spokes.detected,
        dft_k: spokes.dft_k,
        dft_significance: spokes.dft_significance
      };

      notes.push(
        `Chakra center≈(${cx.toFixed(1)}, ${cy.toFixed(1)}), r≈${radius.toFixed(1)}.`,
        `DFT best k=${spokes.dft_k} (expect 24), significance=${spokes.dft_significance}.`,
        `Spokes detected=${spokes.detected}.`
      );
    }

    const report = { aspect_ratio, colors, stripe_proportion, chakra_position, chakra_size, chakra_spokes };
    report._notes = notes;
    return report;
  }

  
  let loadedImage=null, imageName='';
  fileInput.addEventListener('change', async (e)=>{
    const f=e.target.files[0]; if(!f) return;
    if (f.size > 5*1024*1024) { alert('Max file size is 5 MB.'); return; }
    imageName=f.name;
    loadedImage=await loadImageFile(f);
    paintToCanvas(loadedImage);
    runBtn.disabled=false;
    metaEl.textContent=`${f.name} • ${(f.size/1024).toFixed(0)} KB`;
    reportEl.textContent='Ready. Click “Validate”.';
    detailsEl.textContent='—';
    downloadBtn.disabled=true;
  });

  runBtn.addEventListener('click', ()=>{
    if(!loadedImage) return;
    const res=validate();
    reportEl.textContent=JSON.stringify(res,null,2);
    detailsEl.textContent=(res._notes||[]).join('\n')||'—';
    downloadBtn.disabled=false;
  });

  downloadBtn.addEventListener('click', ()=>{
    const blob=new Blob([reportEl.textContent],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    const base=imageName?imageName.replace(/\.[^.]+$/,''):'report';
    a.download=`${base}_flag_validation.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  }


  const flagCanvas = document.getElementById("flagCanvas");
  if (flagCanvas) {
    window.drawFlag = function () {
      const ctx = flagCanvas.getContext("2d");
      const saffron = document.getElementById("saffronPicker").value;
      const white = document.getElementById("whitePicker").value;
      const green = document.getElementById("greenPicker").value;

      const h = flagCanvas.height / 3;
      ctx.fillStyle = saffron;
      ctx.fillRect(0, 0, flagCanvas.width, h);

      ctx.fillStyle = white;
      ctx.fillRect(0, h, flagCanvas.width, h);

      ctx.fillStyle = green;
      ctx.fillRect(0, 2 * h, flagCanvas.width, h);

     
      ctx.beginPath();
      ctx.arc(flagCanvas.width / 2, flagCanvas.height / 2, 30, 0, 2 * Math.PI);
      ctx.strokeStyle = "#000080";
      ctx.lineWidth = 3;
      ctx.stroke();
    };
  }

 


  
  const tributeText = document.getElementById("tributeText");
  if (tributeText) {
    const tributes = [
      "Mahatma Gandhi: Father of the Nation.",
      "Bhagat Singh: Symbol of bravery.",
      "Subhas Chandra Bose: Netaji and leader of INA.",
      "Dr. B. R. Ambedkar: Architect of the Constitution.",
      "Sardar Vallabhbhai Patel: Iron Man of India."
    ];
    tributeText.textContent = tributes[Math.floor(Math.random() * tributes.length)];
  }
})();
