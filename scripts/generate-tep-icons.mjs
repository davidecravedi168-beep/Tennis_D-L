import fs from 'node:fs';
import zlib from 'node:zlib';
const OUT='icons';fs.mkdirSync(OUT,{recursive:true});
const CT=(()=>{const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0}return t})();
const crc=b=>{let c=0xffffffff;for(const x of b)c=CT[(c^x)&255]^(c>>>8);return(c^0xffffffff)>>>0};
const chunk=(t,d)=>{const T=Buffer.from(t),l=Buffer.alloc(4),r=Buffer.alloc(4);l.writeUInt32BE(d.length);r.writeUInt32BE(crc(Buffer.concat([T,d])));return Buffer.concat([l,T,d,r])};
function PNG(w,h,p){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;Buffer.from(p.buffer,p.byteOffset+y*w*4,w*4).copy(raw,y*(w*4+1)+1)}const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])}
const FONT={A:'0111010001111111000110001',D:'1111010001100011000111110',E:'1111110000111101000011111',G:'0111110000101111000101111',I:'1111100100001000010011111',N:'1000111001101011001110001',O:'0111010001100011000101110',P:'1111010001111101000010000',R:'1111010001111101010010010',S:'0111110000011100000111110',T:'1111100100001000010000100'};
function make(size){const S=4,W=size*S,p=new Uint8ClampedArray(W*W*4),B=[4,11,21,255],Y=[255,204,0,255],WH=[255,255,255,255],sc=v=>Math.round(v*W),set=(x,y,c)=>{if(x<0||y<0||x>=W||y>=W)return;let i=(y*W+x)*4;for(let k=0;k<4;k++)p[i+k]=c[k]};for(let i=0;i<p.length;i+=4){p[i]=p[i+1]=p[i+2]=p[i+3]=255}
const poly=(q,c)=>{q=q.map(([x,y])=>[sc(x),sc(y)]);let a=Math.max(0,Math.floor(Math.min(...q.map(v=>v[1])))),b=Math.min(W-1,Math.ceil(Math.max(...q.map(v=>v[1]))));for(let y=a;y<=b;y++){let xs=[];for(let i=0,j=q.length-1;i<q.length;j=i++){let A=q[i],D=q[j];if((A[1]>y)!=(D[1]>y))xs.push((D[0]-A[0])*(y-A[1])/(D[1]-A[1])+A[0])}xs.sort((x,z)=>x-z);for(let k=0;k<xs.length;k+=2)for(let x=Math.ceil(xs[k]);x<=Math.floor(xs[k+1]??xs[k]);x++)set(x,y,c)}};
const rect=(x,y,w,h,c)=>poly([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],c),circle=(cx,cy,r,c)=>{cx=sc(cx);cy=sc(cy);r=sc(r);for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++)if((x-cx)**2+(y-cy)**2<=r*r)set(x,y,c)};
// Approved concept 1: clean white field, fast black/yellow strokes, yellow tennis ball.
poly([[.13,.28],[.54,.105],[.50,.17],[.11,.34]],B);poly([[.17,.35],[.56,.18],[.53,.235],[.15,.40]],B);poly([[.23,.42],[.60,.255],[.57,.315],[.20,.47]],Y);
circle(.73,.225,.105,Y);poly([[.665,.125],[.685,.12],[.715,.32],[.695,.325]],WH);poly([[.785,.13],[.805,.14],[.765,.315],[.745,.31]],WH);
// Large angular TEP wordmark.
poly([[.08,.49],[.37,.49],[.345,.565],[.075,.565]],B);poly([[.185,.55],[.285,.55],[.245,.75],[.145,.75]],B);
poly([[.365,.49],[.625,.49],[.605,.56],[.35,.56]],B);poly([[.35,.55],[.445,.55],[.405,.75],[.31,.75]],B);poly([[.34,.605],[.585,.605],[.57,.67],[.325,.67]],B);poly([[.31,.685],[.565,.685],[.545,.75],[.30,.75]],B);
poly([[.61,.49],[.89,.49],[.875,.555],[.60,.555]],B);poly([[.60,.55],[.695,.55],[.655,.75],[.56,.75]],B);poly([[.82,.54],[.895,.54],[.875,.655],[.80,.655]],B);poly([[.585,.605],[.84,.605],[.825,.67],[.575,.67]],B);
// Small internal wordmark: TENNIS EDGE PRO, with EDGE in yellow.
if(size>=128){const text='TENNIS EDGE PRO',unit=.0082,gap=.0042,y=.835;let total=0;for(const ch of text)total+=ch===' '?unit*3:unit*5+gap;let x=(1-total)/2;for(const ch of text){if(ch===' '){x+=unit*3;continue}const bits=FONT[ch];const col='EDGE'.includes(ch)&&x>.43&&x<.68?Y:B;for(let r=0;r<5;r++)for(let c=0;c<5;c++)if(bits?.[r*5+c]==='1')rect(x+c*unit,y+r*unit,unit*.82,unit*.82,col);x+=unit*5+gap}}
const out=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){let s=[0,0,0,0];for(let yy=0;yy<S;yy++)for(let xx=0;xx<S;xx++){let i=((y*S+yy)*W+x*S+xx)*4;for(let k=0;k<4;k++)s[k]+=p[i+k]}let o=(y*size+x)*4;for(let k=0;k<4;k++)out[o+k]=Math.round(s[k]/S/S)}return PNG(size,size,out)}
for(const s of [32,180,192,512])fs.writeFileSync(`${OUT}/${s===180?'apple-touch-icon':s===32?'favicon-32':`icon-${s}`}.png`,make(s));
fs.writeFileSync('manifest.webmanifest',JSON.stringify({name:'Tennis Edge Pro',short_name:'TEP',start_url:'./',display:'standalone',background_color:'#ffffff',theme_color:'#ffffff',icons:[{src:'./icons/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:'./icons/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]},null,2)+'\n');
console.log('TEP approved icon generated');
