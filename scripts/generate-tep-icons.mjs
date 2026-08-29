import fs from 'node:fs';
import zlib from 'node:zlib';

const OUT='icons';
fs.mkdirSync(OUT,{recursive:true});

const CRC_TABLE=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[n]=c>>>0}return t})();
const crc32=b=>{let c=0xffffffff;for(const x of b)c=CRC_TABLE[(c^x)&255]^(c>>>8);return(c^0xffffffff)>>>0};
const chunk=(type,data)=>{const t=Buffer.from(type);const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])};
function png(w,h,rgba){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;Buffer.from(rgba.buffer,rgba.byteOffset+y*w*4,w*4).copy(raw,y*(w*4+1)+1)}const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])}
function make(size){
  const S=3,w=size*S,h=w,p=new Uint8ClampedArray(w*h*4);const idx=(x,y)=>(y*w+x)*4;
  const set=(x,y,c)=>{if(x<0||y<0||x>=w||y>=h)return;const i=idx(x,y);p[i]=c[0];p[i+1]=c[1];p[i+2]=c[2];p[i+3]=c[3]??255};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)set(x,y,[255,255,255,255]);
  const sc=v=>Math.round(v*w), black=[5,12,22,255], yellow=[255,205,36,255], white=[255,255,255,255];
  const poly=(pts,c)=>{const ys=pts.map(q=>q[1]),minY=Math.max(0,Math.floor(Math.min(...ys))),maxY=Math.min(h-1,Math.ceil(Math.max(...ys)));for(let y=minY;y<=maxY;y++){const xs=[];for(let i=0,j=pts.length-1;i<pts.length;j=i++){const a=pts[i],b=pts[j];if((a[1]>y)!=(b[1]>y))xs.push((b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])}xs.sort((a,b)=>a-b);for(let k=0;k<xs.length;k+=2)for(let x=Math.max(0,Math.ceil(xs[k]));x<=Math.min(w-1,Math.floor(xs[k+1]??xs[k]));x++)set(x,y,c)}};
  const rect=(x1,y1,x2,y2,c)=>poly([[sc(x1),sc(y1)],[sc(x2),sc(y1)],[sc(x2),sc(y2)],[sc(x1),sc(y2)]],c);
  const circle=(cx,cy,r,c)=>{cx=sc(cx);cy=sc(cy);r=sc(r);for(let y=Math.max(0,cy-r);y<=Math.min(h-1,cy+r);y++)for(let x=Math.max(0,cx-r);x<=Math.min(w-1,cx+r);x++)if((x-cx)**2+(y-cy)**2<=r*r)set(x,y,c)};
  const line=(x1,y1,x2,y2,t,c)=>{x1=sc(x1);y1=sc(y1);x2=sc(x2);y2=sc(y2);t=sc(t);const minX=Math.max(0,Math.floor(Math.min(x1,x2)-t)),maxX=Math.min(w-1,Math.ceil(Math.max(x1,x2)+t)),minY=Math.max(0,Math.floor(Math.min(y1,y2)-t)),maxY=Math.min(h-1,Math.ceil(Math.max(y1,y2)+t));const vx=x2-x1,vy=y2-y1,l2=vx*vx+vy*vy;for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const u=Math.max(0,Math.min(1,((x-x1)*vx+(y-y1)*vy)/l2)),dx=x-(x1+u*vx),dy=y-(y1+u*vy);if(dx*dx+dy*dy<=t*t)set(x,y,c)}};
  // speed streaks
  poly([[sc(.14),sc(.31)],[sc(.57),sc(.12)],[sc(.52),sc(.18)],[sc(.12),sc(.36)]],black);
  poly([[sc(.18),sc(.36)],[sc(.59),sc(.18)],[sc(.55),sc(.23)],[sc(.16),sc(.40)]],black);
  poly([[sc(.24),sc(.40)],[sc(.61),sc(.24)],[sc(.58),sc(.29)],[sc(.22),sc(.44)]],yellow);
  // tennis ball
  circle(.72,.22,.105,yellow);line(.66,.13,.70,.31,.011,white);line(.78,.13,.75,.31,.011,white);
  // stylized TEP
  poly([[sc(.10),sc(.47)],[sc(.37),sc(.47)],[sc(.34),sc(.54)],[sc(.08),sc(.54)]],black);poly([[sc(.20),sc(.53)],[sc(.29),sc(.53)],[sc(.25),sc(.72)],[sc(.16),sc(.72)]],black);
  poly([[sc(.37),sc(.47)],[sc(.61),sc(.47)],[sc(.58),sc(.54)],[sc(.35),sc(.54)]],black);poly([[sc(.35),sc(.53)],[sc(.44),sc(.53)],[sc(.41),sc(.72)],[sc(.32),sc(.72)]],black);poly([[sc(.34),sc(.59)],[sc(.56),sc(.59)],[sc(.53),sc(.65)],[sc(.33),sc(.65)]],black);poly([[sc(.32),sc(.66)],[sc(.55),sc(.66)],[sc(.52),sc(.72)],[sc(.31),sc(.72)]],black);
  poly([[sc(.61),sc(.47)],[sc(.86),sc(.47)],[sc(.84),sc(.54)],[sc(.60),sc(.54)]],black);poly([[sc(.60),sc(.53)],[sc(.69),sc(.53)],[sc(.66),sc(.72)],[sc(.57),sc(.72)]],black);poly([[sc(.80),sc(.52)],[sc(.87),sc(.52)],[sc(.85),sc(.62)],[sc(.78),sc(.62)]],black);poly([[sc(.60),sc(.58)],[sc(.82),sc(.58)],[sc(.79),sc(.64)],[sc(.59),sc(.64)]],black);
  // compact wordmark accent
  if(size>=128){rect(.19,.82,.43,.835,black);rect(.46,.82,.61,.835,yellow);rect(.64,.82,.80,.835,black)}
  // downsample 3x for soft edges
  const out=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){let s=[0,0,0,0];for(let yy=0;yy<S;yy++)for(let xx=0;xx<S;xx++){const i=((y*S+yy)*w+(x*S+xx))*4;for(let k=0;k<4;k++)s[k]+=p[i+k]}const o=(y*size+x)*4;for(let k=0;k<4;k++)out[o+k]=Math.round(s[k]/(S*S))}
  return png(size,size,out);
}
for(const s of [32,180,192,512])fs.writeFileSync(`${OUT}/${s===180?'apple-touch-icon':s===32?'favicon-32':`icon-${s}`}.png`,make(s));
fs.writeFileSync('manifest.webmanifest',JSON.stringify({name:'Tennis Edge Pro',short_name:'TEP',start_url:'./',display:'standalone',background_color:'#ffffff',theme_color:'#07111b',icons:[{src:'./icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'./icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},null,2)+'\n');
console.log('TEP icons generated:',fs.readdirSync(OUT).join(', '));
