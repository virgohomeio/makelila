/* ── Products module — static data ──────────────────────────────────────────
   Ported from the products-mockup.html scratchpad (Jul 2026).
   All product lines: LILA Pro, Mini, Mega, makeLILA, Lovely App,
   LILA Shop, LILA Marketplace, plus Technical R&D projects.
   ──────────────────────────────────────────────────────────────────────── */

export interface StageItem { id: string; label: string; }
export interface KPI       { label: string; val: string; sub: string; cls: string; }
export interface Issue {
  title: string; sev: 'critical' | 'high' | 'medium' | 'low';
  tag: string; team: string; meta: string; mpBlocker?: boolean;
}
export interface Note     { label: string; val: string; }
export interface TimelineEntry { id: string; label: string; status: 'done'|'active'|'blocked'|'future'; date: string; }
export interface VolumeEntry {
  stage: string; label?: string; count: number|null;
  type: 'actual'|'planned'|'tbd'; shipped?: number; sub?: string;
}
export interface TeamMember {
  id: string; name: string; initials: string; role: string;
  type: 'primary'|'supporting'; desc: string;
}
export interface BomItem { pn: string; name: string; qty: number; unit: string; cost?: string; spec?: string; }
export interface BomGroup { name: string; icon: string; supplier: string; items: BomItem[]; }
export interface ProBom {
  partNo: string; version: string; date: string; supplier: string;
  groups: BomGroup[];
}
export interface ICPProfile {
  tier: string; persona: string; profile: string;
  demographics: string[]; psychographics: string[];
  triggers: string[]; barriers: string[];
}
export interface PRDData {
  version: string; updated: string; summary: string; problem: string;
  targetMarket: string; goalLine: string; keySpecs?: string[];
  mpRequirements: string; docRef?: string; icp?: ICPProfile[];
}
export interface JourneyStep {
  stage: string; sub?: string; touchpoints?: string[];
  emotion: string; jtbd?: string;
}
export interface PMFMetric {
  label: string; val: string; target: string;
  status: 'ok'|'warn'|'crit'|'na'; note: string;
}
export interface PMFDimension {
  id: string; label: string; question: string; metrics: PMFMetric[];
}
export interface PMFData {
  updated: string; status: 'ok'|'warn'|'crit'|'early';
  statusLabel: string; summary: string; dimensions: PMFDimension[];
}
export interface Product {
  name: string; badgeClass: string|null; badgeCount: string|null;
  currentStage: string; currentStatus: string; currentLabel: string;
  customStages?: StageItem[]; stageStates: Record<string,string>;
  kpis: KPI[]; issues: Issue[]; notes: Note[];
  timeline: TimelineEntry[]; volumes: VolumeEntry[];
  bom: BomItem[] | ProBom | [];
  team: TeamMember[];
  prd?: PRDData; journey?: JourneyStep[]; pmf?: PMFData;
}

export const STAGES: StageItem[] = [
  { id:'EP',    label:'Eng. Prototype'  },
  { id:'EVT',   label:'Eng. Validation' },
  { id:'DVT',   label:'Design Valid.'   },
  { id:'PVT',   label:'Pilot Valid.'    },
  { id:'PILOT', label:'Pilot Prod.'     },
  { id:'MP',    label:'Mass Prod.'      },
];

export const PRODUCTS: Record<string, Product> = {
  pro: {
    name:'LILA Pro', badgeClass:'badge-crit', badgeCount:'24',
    currentStage:'PP', currentStatus:'in-progress',
    currentLabel:'PP — In Progress',
    customStages:[
      { id:'EP',  label:'Eng. Prototype'  },
      { id:'EVT', label:'Eng. Validation' },
      { id:'DVT', label:'Design Valid.'   },
      { id:'PVT', label:'Pilot Valid.'    },
      { id:'PP',  label:'Pilot Prod.'     },
      { id:'MP',  label:'Mass Prod.'      },
    ],
    stageStates:{ EP:'done', EVT:'done', DVT:'done', PVT:'done', PP:'active', MP:'future' },
    kpis:[
      { label:'Current Stage', val:'PP',      sub:'P100X · 100 units · BenLiang D0.11',  cls:'' },
      { label:'Open Issues',   val:'24',      sub:'5 critical · 7 MP blockers',           cls:'v-crit' },
      { label:'MP Gate',       val:'Q1 2027', sub:'1,200 units/yr target · fin. model',   cls:'' },
      { label:'Shipped (total)',val:'177',    sub:'across DVT + PVT batches',             cls:'' },
    ],
    issues:[
      { title:'Inner shell material change', sev:'critical',
        tag:'DVT', team:'Ben Liang',
        meta:'Current material shows heat distribution issues — thermal expansion causes inner shell to press against outer shell. Alt. material samples arriving Jul 8; must validate thermal expansion coefficients before P100X integration.' },
      { title:'Upon Update, Software Doesn\'t Start', sev:'critical', mpBlocker:true,
        tag:'Firmware · STM32', team:'Lezhong',
        meta:'After OTA update firmware fails to start — fans blow near 100%. Only occurs when firmware is absent or not running desired version. (RND_SRC_MainCpu_v5 #50)' },
      { title:'Side Latch Failures', sev:'critical', mpBlocker:true,
        tag:'Hardware · Latch Mechanism', team:'Ben Liang',
        meta:'Glue-on latches break off during shipping or normal use; moisture degrades adhesive bond. 10 field tickets (7 open, 3 resolved). Required: redesign to integrated snap-fit or screw-mounted mechanical clip; test 500 open/close cycles at 80% RH.' },
      { title:'Lid Switch Redesign — Microswitch → Magnetic', sev:'critical', mpBlocker:true,
        tag:'Hardware · Lid Interlock', team:'Ben Liang',
        meta:'Contact-based microswitches fail from pin depression and calibration error — causes false lid-open errors. Back-lid microswitch continuously depressed during shipping → 3 confirmed damage cases. Redesign to magnetic induction / Hall-effect lid interlock confirmed Jul 6. Workaround: 1 jumper wire per outgoing unit until fix ships.' },
      { title:'Motor Failures — Prioritize BLDC Replacement', sev:'critical', mpBlocker:true,
        tag:'Hardware · Drive System', team:'Ben Liang',
        meta:'Chamber motors fail to turn or are installed with incorrect shaft orientation; some fail after weeks of use. 3 field tickets (2 open, 1 resolved). Motor batch delivery date needed before PVT planning can begin — Chen to confirm. Replacement path validated: BLDC motor+gearbox combo (300 RMB / 2 sets) tested on large-machine prototype Jun 2026 — keyed shaft eliminates mis-installation. Target: BLDC swap locked before MP gate.' },
      { title:'On Startup Motors Don\'t Mix', sev:'high',
        tag:'Firmware · STM32', team:'Lezhong',
        meta:'Motors sometimes fail to mix on startup; reset fixes it. Possibly AC-power related. (RND_SRC_MainCpu_v5 #48)' },
      { title:'Indefinite Blinking Green During OTA', sev:'high',
        tag:'Firmware · OTA', team:'Lezhong',
        meta:'OTA should take 25–30 min but blinking continues indefinitely. Possible causes: microswitch disengagement, ESP32 bug, or STM32 bug. (RND_SRC_MainCpu_v5 #36)' },
      { title:'OTA Update Restarts When Back-Lid is Open', sev:'high',
        tag:'Firmware · P50', team:'Lezhong',
        meta:'Opening back lid during OTA causes update to restart from beginning once lid is re-closed. (P50_v1 #7)' },
      { title:'Composting Control Improvement', sev:'high', mpBlocker:true,
        tag:'Firmware · Core', team:'Lezhong',
        meta:'Audit and correct composting control implementation. Full review of control loop logic required. (RND_SRC_MainCpu_v5 #56)' },
      { title:'Filter Cup / Screen Breakage', sev:'high',
        tag:'Hardware · Filtration', team:'Ben Liang',
        meta:'Friction-fit filtration screen breaks off compost chamber during handling or shipping. 4 field tickets (2 open, 2 resolved). Required: redesign attachment with snap-ring, threaded collar, or welded joint; ISTA 3A drop resistance test.' },
      { title:'Shipping / Packaging Damage', sev:'high', mpBlocker:true,
        tag:'Hardware · Packaging', team:'Ben Liang',
        meta:'Packaging designed for palletized container freight — not individual parcel delivery (FedEx/Canpar/Purolator). 7 field tickets. Required: redesign to ISTA 3A parcel shipping standard; foam cradles for latches, filter cups, trays.' },
      { title:'rH Values Very Low from BME Sensor', sev:'medium',
        tag:'Firmware · Sensors', team:'Lezhong',
        meta:'When real rH > 60%, measured values drop below 10% and must be compensated. (RND_SRC_MainCpu_v5 #57)' },
      { title:'Excessive Relay Ticking at End of OTA Push', sev:'medium',
        tag:'Firmware · P50', team:'Lezhong',
        meta:'Excessive ticking noise as soon as "Update AI data" finishes. Occurred 4 times during OTA push testing. (P50_v1 #9)' },
      { title:'No Messages Sent in ERROR State', sev:'medium',
        tag:'Firmware · P50', team:'Lezhong',
        meta:'Machine does not send MQTT messages when in ERROR state. (P50_v1 #3)' },
      { title:'Signed Image for ESP32 Bin File', sev:'medium', mpBlocker:true,
        tag:'Firmware · Security', team:'Junaid',
        meta:'Required for SOC 2 Compliance readiness. Firmware binary must be signed before production. (P50_v1 #23)' },
      { title:'Integrate SSL Certificate into ESP32 (MQTT/HTTPS)', sev:'medium',
        tag:'Firmware · Security', team:'Lezhong',
        meta:'MQTT and HTTPS encryption. WiFi credential upload via POST from Lovely App using ESP32 API. (P50_v1 #20)' },
      { title:'Tray Breakage', sev:'medium',
        tag:'Hardware · Drip Tray', team:'Ben Liang',
        meta:'Drip trays crack during shipping or first use. 4 field tickets. Required: upgrade material to glass-fiber reinforced PP or ABS; add corner reinforcement ribs; foam cradle in packaging.' },
      { title:'Rusted Fasteners', sev:'medium',
        tag:'Hardware · Fasteners', team:'Ben Liang',
        meta:'Carbon steel screws corrode within weeks in the moisture-rich composting environment. 2 field tickets. Required: replace ALL fasteners with SS304.' },
      { title:'Lid Closure & Alignment', sev:'medium',
        tag:'Hardware · Lid System', team:'Ben Liang',
        meta:'Back lid won\'t close without excessive force; front lid opens on its own due to warping. Required: increase lid alignment tolerance; add front lid magnet or positive-latch.' },
      { title:'Electrical / Cord Issues', sev:'medium',
        tag:'Hardware · Electrical', team:'Ben Liang',
        meta:'Power cord outer casing damage, PTC heater element failures, LED display not functioning. 6 field tickets (all resolved). Required: strain relief testing; electrical safety check in final QC.' },
      { title:'Missing Components at Shipment', sev:'medium',
        tag:'Hardware · Assembly QC', team:'Ben Liang',
        meta:'Units shipped without required components: gaskets, water trays, filter cups, gear boxes, starter pellet bags. Required: visual packing verification checklist with photo confirmation.' },
      { title:'Moisture Leakage from Base', sev:'medium',
        tag:'Hardware · Sealing', team:'Ben Liang',
        meta:'Water leaks from unit base onto customer floors. 4 field tickets. Required: improve base seal design; add secondary drip containment; 48-hour water retention test during QA.' },
      { title:'TÜV Certification Documentation Gaps', sev:'medium',
        tag:'Hardware · Certification', team:'Ben Liang',
        meta:'Ethan at TÜV requires UL standard numbers and compliance certs for all components. Scope: whole-machine TÜV certification. Action: supplement missing docs, submit revised cert forms. Two machines at TÜV Shanghai facility.' },
    ],
    notes:[
      { label:'Pilot Status',     val:'P100X (100 units, BenLiang D0.11) is in-production at MicroArt, Markham. ETA Oct 2026. 350 units manufactured across DVT + PVT; 177 shipped to customers.' },
      { label:'MP Prerequisites', val:'7 issues flagged as MP blockers: Side Latch (critical), Motor Failures (critical), Lid Switch Redesign (critical), OTA firmware failure (critical), Packaging/Shipping Damage, Composting Control, Signed Firmware. Must resolve before MP gate.' },
      { label:'Financial Target', val:'Q4 2026 — first EBITDA-positive quarter ($184,583 target, fin. model v13). 2027 target: 1,200 PRO units/year. Q1 2027 MP ramp contingent on blocker resolution.' },
    ],
    timeline:[
      { id:'EP',  label:'Engineering Prototype',  status:'done',   date:'2024 · early prototypes' },
      { id:'EVT', label:'Engineering Validation', status:'done',   date:'Feb 2025 · P50 (50 units · MBV)' },
      { id:'DVT', label:'Design Validation',      status:'done',   date:'Aug 2025 – Mar 2026 · P150 + P50N + P100 (300 units)' },
      { id:'PVT', label:'Pilot Validation',        status:'done',   date:'Apr 2026 · P100 field validation (89 units shipped)' },
      { id:'PP',  label:'Pilot Production',        status:'active', date:'Jul 2026 · P100X · 100 units · BenLiang D0.11 · in-production' },
      { id:'MP',  label:'Mass Production',         status:'future', date:'Q1 2027 · 1,200 units/yr target (fin. model v13)' },
    ],
    volumes:[
      { stage:'P50',   label:'DVT — P50',     count:50,   type:'actual',  shipped:16, sub:'v3.5 · MBV · Feb 2025 · 16 shipped' },
      { stage:'P150',  label:'PVT — P150',    count:150,  type:'actual',  shipped:42, sub:'v3.6 · MBV · Aug 2025 · 42 shipped' },
      { stage:'P50N',  label:'PVT — P50N',    count:50,   type:'actual',  shipped:30, sub:'v3.7 · LC · Dec 2025 · 30 shipped' },
      { stage:'P100',  label:'PVT — P100',    count:100,  type:'actual',  shipped:89, sub:'LC · Apr 2026 · 89 shipped' },
      { stage:'P100X', label:'PILOT — P100X', count:100,  type:'planned', shipped:0,  sub:'BenLiang D0.11 · in-production · ETA Oct 2026' },
      { stage:'2027',  label:'MP — 2027',     count:1200, type:'planned',             sub:'fin. model v13 · Q1 2027 ramp · 100 units/mo' },
      { stage:'2028',  label:'MP — 2028',     count:3700, type:'planned',             sub:'fin. model v13 · fundraising model' },
    ],
    bom: {
      partNo:'BOM-L3600-D0.11', version:'D0.11', date:'Jun 2026',
      supplier:'BenLiang (assembly); MicroArt Markham (P100X production)',
      groups:[
        { name:'Structural Shells & Injection Parts', icon:'◻', supplier:'Dongguan Yunjing Plastic; Guangdong Hongyu Precision; Shenzhen Jiageng', items:[
          { pn:'L3600-D0001-A04-R', name:'Front housing main shell', spec:'Red PP+30%GF, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0002-A03-R', name:'Rear cover main housing', spec:'Red PP+30%GF, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0003-A04-N', name:'Base main body shell', spec:'Natural PP+30%GF, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0007-A01-W', name:'Main body inner liner', spec:'White PP, injection moulded', qty:1, unit:'pc' },
          { pn:'L3600-D0008-A00-B', name:'Lid inner liner', spec:'Black ABS, injection moulded', qty:2, unit:'pc' },
          { pn:'L3600-D0016-A00-R', name:'Front housing lid', spec:'Red PP+30%GF, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0019-A03-R', name:'Compost chamber body', spec:'Red PP+30%GF, matte injection', qty:2, unit:'pc' },
          { pn:'L3600-D0020-A00-R', name:'Front lid chamber', spec:'Red PP+30%GF, matte injection', qty:2, unit:'pc' },
          { pn:'L3600-D0256-A01-R', name:'Compost chamber top lid (right)', spec:'Red PP+30%GF+TPU70, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0257-A00-R', name:'Rear microswitch cover', spec:'Red POM, matte injection', qty:1, unit:'pc' },
          { pn:'L3600-D0258-A00-N', name:'Base body O-ring gasket', spec:'Natural silicone 55°, 1.5mm dia.', qty:1, unit:'pc' },
          { pn:'L3600-D0260-A00-W', name:'UI interaction panel', spec:'White ABS 757+UV, spray matte', qty:1, unit:'pc' },
          { pn:'L3600-D0296-A00-W', name:'Drip tray / catch tray', spec:'White PP, 640x460mm oval', qty:1, unit:'pc' },
          { pn:'L3600-D0297-A00-B', name:'Door lock button (left)', spec:'Black ABS spray-painted', qty:1, unit:'pc' },
          { pn:'L3600-D0298-A00-B', name:'Door lock button (right)', spec:'Black ABS spray-painted', qty:1, unit:'pc' },
        ]},
        { name:'Mechanical Hardware', icon:'⚙', supplier:'Dongguan Zhizhuo (fasteners); Dongguan Tianping (springs)', items:[
          { pn:'L3600-A0203-00', name:'Rear cover door latch socket (female)', spec:'SS304 ball-detent 43mm, brushed', qty:1, unit:'pc' },
          { pn:'L3600-A0204-00', name:'Rear cover door latch catch (male)', spec:'SS304 ball-detent 43mm, brushed', qty:1, unit:'pc' },
          { pn:'L3600-A0208-00', name:'Cover latch spring', spec:'OD17.6×wire1.0×H35mm, Ni-plated steel, 100k cycles', qty:2, unit:'pc' },
          { pn:'L3600-A0211-01', name:'Gearbox - bevel helical grind', spec:'NT045A-LP1-S3-D8, 2000RPM ratio:1, aluminium alloy', qty:2, unit:'pc' },
          { pn:'L3600-A0212-01', name:'Chamber bearing', spec:'ID12×OD21×T5mm, waterproof SS (6801)', qty:4, unit:'pc' },
          { pn:'L3600-A0213-01', name:'Chamber shaft seal', spec:'ID12×OD22×T5mm, NBR standard lip seal', qty:4, unit:'pc' },
          { pn:'L3600-A0214-00', name:'Chamber thrust bearing [enhanced]', spec:'SF10-17 10×17×5mm, SS', qty:4, unit:'pc' },
          { pn:'L3600-A0220-00', name:'Caster wheel', spec:'L43×W24.5×H27mm, hole pitch 32mm, zinc-plated carbon steel', qty:2, unit:'pc' },
          { pn:'L3600-A0280-00', name:'Check valve', spec:'Silicone red 65°, OD18mm', qty:4, unit:'pc' },
          { pn:'L3600-A0281-00', name:'Inner lid sealing tube', spec:'Silicone OD3×ID2mm, 50° hardness', qty:1.45, unit:'m' },
          { pn:'L3600-A0300-00', name:'SS filter mesh', spec:'20 mesh, 0.4mm wire dia., SS304, 127×72mm', qty:1, unit:'pc' },
        ]},
        { name:'Metal Parts (SS304)', icon:'◈', supplier:'Shenzhen Hengyu Precision; Shenzhen Henglirong Hardware; Yuyao Guangming', items:[
          { pn:'L3600-E0080-A00-O', name:'Heater plate metal cover', spec:'SUS304 stamped, natural finish', qty:2, unit:'pc' },
          { pn:'L3600-E0087-A00-O', name:'Stirring blade P1', spec:'SUS304, natural finish', qty:2, unit:'pc' },
          { pn:'L3600-E0088-A00-O', name:'Stirring shaft', spec:'SUS303 machined, passivated surface', qty:2, unit:'pc' },
          { pn:'L3600-E0089-A00-O', name:'Stirring blade P2-6', spec:'SUS304, natural finish', qty:10, unit:'pc' },
          { pn:'L3600-E0090-A00-O', name:'Stirring blade P7', spec:'SUS304, natural finish', qty:2, unit:'pc' },
          { pn:'L3600-E0130-A01-O', name:'Side hook pair', spec:'SUS304, passivated surface', qty:2, unit:'pc' },
          { pn:'L3600-E0143-A01-O', name:'Drive coupler (male)', spec:'Powder metallurgy, natural finish', qty:2, unit:'pc' },
          { pn:'L3600-E0144-A01-O', name:'Drive coupler (female)', spec:'Powder metallurgy, natural finish', qty:2, unit:'pc' },
        ]},
        { name:'Drive & Air System', icon:'⟳', supplier:'Ningbo Deli Electromechanical (motors); Dongguan Runda Cooling (fans)', items:[
          { pn:'L3600-MTA0001-01', name:'Left compost motor', spec:'ZWZ60K3.132.003WX039NBLW, white terminal', qty:1, unit:'pc' },
          { pn:'L3600-MTA0002-01', name:'Right compost motor', spec:'ZWZ60K3.132.003WX039NBLW, red terminal', qty:1, unit:'pc' },
          { pn:'L3600-FN0001-01', name:'Air pump (exhaust blower)', spec:'RB1440B12H-FPS', qty:1, unit:'pc' },
          { pn:'L3600-FN0002-01', name:'Intake fan', spec:'S5020B12VH-PA', qty:1, unit:'pc' },
        ]},
        { name:'Thermal System', icon:'◉', supplier:'Shenzhen Fulianida (PTC heaters); Zhejiang Jieyu Biotech (plasma lamp)', items:[
          { pn:'L3600-TP0001-01', name:'Intake port PTC heater block', spec:'C3532PTC-0002, 48×40×20.5mm', qty:1, unit:'pc' },
          { pn:'L3600-TP0004-02', name:'Blower PTC heater block', spec:'C3532PTC-0001, 60×48×20.5mm', qty:1, unit:'pc' },
          { pn:'L3600-TP0005-01', name:'Compost heater pad A (left, yellow)', spec:'C3532GJ-0001, 143×179mm, yellow shell', qty:1, unit:'pc' },
          { pn:'L3600-TP0006-01', name:'Compost heater pad B (right, green)', spec:'C3532GJ-0002, 143×179mm, green shell', qty:1, unit:'pc' },
          { pn:'L3600-LT0001-00', name:'Plasma deodorizing lamp', spec:'DLZ-12V-1080D', qty:1, unit:'pc' },
        ]},
        { name:'Cables & Harnesses', icon:'≋', supplier:'Shenzhen Henghui (恒辉鑫五金电子)', items:[
          { pn:'L3600-C0010-A00', name:'AC power input cable (15A)', spec:'HHX-VC01-00007, 3000mm', qty:1, unit:'pc' },
          { pn:'L3600-C0027-A00', name:'Chamber BME688 sensor cable', spec:'HHX-VC01-00010, 1080mm', qty:1, unit:'pc' },
          { pn:'L3600-C0033-A00', name:'Plasma lamp cable', spec:'HHX-VC01-00015, 1110mm', qty:1, unit:'pc' },
          { pn:'L3600-C0042-A00', name:'Rear lid safety switch cable', spec:'HHX-VC01-00001, 1240mm', qty:1, unit:'pc' },
          { pn:'L3600-C0046-A00', name:'LED board cable', spec:'HHX-VC01-00014, 80mm', qty:1, unit:'pc' },
          { pn:'L3600-C0049-A00', name:'AC button board cable', spec:'HHX-VC01-00008, 810mm', qty:1, unit:'pc' },
          { pn:'L3600-C0050-A00', name:'AC main board cable', spec:'HHX-VC01-00009, 790mm', qty:1, unit:'pc' },
          { pn:'L3600-C0007-A00', name:'UI board cable', spec:'HHX-VC01-00013, 1060mm', qty:1, unit:'pc' },
          { pn:'L3600-C0051-00', name:'Front speaker harness assembly', spec:'HHX-VC01-00018, 100mm; KELIKING KLJ-3605W2R8 2R8', qty:1, unit:'pc' },
        ]},
        { name:'PCB Assemblies', icon:'▣', supplier:'BenLiang / JLCPCB (嘉立创)', items:[
          { pn:'L3600-BA0001-A02', name:'Main control PCBA', spec:'P100_mainBoard_V02, 247×180×1.6mm, 4-layer FR4; ESP32-C6 + STM32U575; ~80 passives', qty:1, unit:'pc' },
          { pn:'L3600-BA0004-A00', name:'UI LED PCBA', spec:'32×32×1.6mm, 2-layer; 8× WS2812B RGB LEDs', qty:1, unit:'pc' },
          { pn:'L3600-BA0009-A01', name:'Exhaust BME688 sensor PCBA', spec:'29×19×1.6mm, 2-layer; Bosch BME688 temp/humidity/gas sensor', qty:1, unit:'pc' },
          { pn:'L3600-BA0020-A00', name:'Power switch PCBA', spec:'52×52×1.6mm, 2-layer; main power button SW1', qty:1, unit:'pc' },
          { pn:'L3600-BA0021-A01', name:'Intake BME688 sensor PCBA', spec:'23×19×1.6mm, 2-layer; Bosch BME688 temp/humidity/gas sensor', qty:1, unit:'pc' },
        ]},
        { name:'Filter Module', icon:'○', supplier:'BenLiang (assembly); Guangdong Yuelong Activated Carbon', items:[
          { pn:'L3600-A0295-00', name:'Activated carbon filter bag assembly', spec:'1.2kg activated carbon, 4mm column, iodine 900; kraft paper bag sealed', qty:1, unit:'pc' },
        ]},
        { name:'Packaging', icon:'□', supplier:'Dongguan Dawei Packaging (cartons); Hengxinjia (EPE foam)', items:[
          { pn:'L3600-P0011-A00', name:'PE protective bag', spec:'80×130cm, 0.04mm PE, 6 ventilation holes', qty:1, unit:'pc' },
          { pn:'L3600-P0012-A00', name:'Top EPE foam cushion', spec:'White, 595×386×240mm', qty:1, unit:'pc' },
          { pn:'L3600-P0013-A00', name:'Bottom EPE foam cushion', spec:'White, 595×386×150mm', qty:1, unit:'pc' },
          { pn:'L3600-P0014-A00', name:'Outer box base tray', spec:'59.5×38.6×12.5cm, BC corrugated, kraft 195g', qty:1, unit:'pc' },
          { pn:'L3600-P0016-A00', name:'Outer box lid', spec:'60.9×40×94cm, BC corrugated, kraft 195g', qty:1, unit:'pc' },
          { pn:'L3600-P0024-A00', name:'TUV certification label', spec:'Matte white PVC, 20×40mm (bottom of housing)', qty:1, unit:'pc' },
          { pn:'L3600-P0025-A00', name:'SN barcode label', spec:'Matte silver PET, 39×8mm (main board + outer box)', qty:2, unit:'pc' },
        ]},
        { name:'Embedded Firmware', icon:'⌗', supplier:'VCycene Engineering · Lezhong', items:[
          { pn:'L3600-FW-0001', name:'STM32 Main CPU Firmware', spec:'Composting cycle control, motor drive, BME688 sensor polling, lid interlock — STM32U575VGT · Build: 3600-STM32-DVT-0001 · ✅ PP Ready · Lezhong (Jul 8): "Ready with a few release builds"', qty:1, unit:'build' },
          { pn:'L3600-FW-0002', name:'ESP32 P50 Connectivity Firmware', spec:'WiFi provisioning (BLE), MQTT telemetry uplink, signed OTA image relay to STM32 — ESP32-S3 (P50 module) · Build: 3600-ESP32-DVT-0001 · ⚠️ PP Ready (caveat) · SSL cert and signed OTA not yet implemented — must resolve before PVT', qty:1, unit:'build' },
          { pn:'L3600-FW-0004', name:'Compost AI Model Package', spec:'Microbial phase classifier and composting cycle parameter tables; OTA-pushed as signed binary bundle · ❌ Not PP Ready · Models embedded into STM32 firmware; standalone OTA model package is post-DVT', qty:1, unit:'bundle' },
          { pn:'L3600-FW-0005', name:'MQTT Cloud Backend', spec:'Mosquitto broker + telemetry ingestor + per-device TLS/PKI cert provisioner · ⚠️ PP Ready (caveat) · Backend deployed ≥99% uptime. Cert provisioning just implemented Jul 8 — not yet tested end-to-end', qty:1, unit:'service' },
          { pn:'L3600-FW-0007', name:'OTA Firmware Release Pipeline', spec:'Uploads signed binaries to GCS; sends COMMAND topic via MQTT; SOC2 audit-logged · ❌ Not PP Ready · Not tested, signing keys WIP. OTA release pipeline is a PVT/MP blocker', qty:1, unit:'tool' },
          { pn:'L3600-FW-0008', name:'Factory Test Firmware (STM32)', spec:'Alternate STM32 image used at manufacturing stations to validate PCB assembly, sensors, and motor circuits · ✅ PP Ready · Lezhong: "Ready. Working on motor current sensing improvement branch"', qty:1, unit:'tool' },
          { pn:'L3600-FW-0009', name:'Manufacturing Station Tools', spec:'Python suite on factory test stations; connects to unit via WiFi, queries test-firmware endpoints, delivers production .bin via FTP · ✅ PP Ready · Tested at Ben Liang factory and internally', qty:1, unit:'tool' },
        ]},
      ],
    } as ProBom,
    team:[
      { id:'huayi',   name:'Huayi Gao', initials:'HG', role:'Product Manager',     type:'primary',
        desc:'Product manager for LILA Pro. Owns the product roadmap, coordinates between Ben Liang, Lezhong, and the VCycene team, and manages DVT gate reviews and milestone tracking.' },
      { id:'junaid',  name:'Junaid',    initials:'JU', role:'CS & Infrastructure', type:'primary',
        desc:'Infrastructure and firmware support. Manages the deployment environment, Supabase back-end integrations, and firmware build pipeline alongside Lezhong.' },
      { id:'lezhong', name:'Lezhong',   initials:'LZ', role:'Firmware Engineer',   type:'primary',
        desc:'Firmware development for LILA Pro. Core composting control logic, sensor integration, and motor control routines. Works closely with Junaid on the infrastructure side.' },
      { id:'ben',     name:'Ben Liang', initials:'BL', role:'ODM Partner',         type:'primary',
        desc:'Strategic ODM partner. Handles R&D, electrical design, mechanical engineering, and production for LILA Pro — from DVT batch manufacturing through PVT.' },
      { id:'kevin',   name:'Kevin',     initials:'KV', role:'Production',          type:'supporting',
        desc:'Production coordination, working directly with Ben Liang. Manages supplier relationships and quality checks on the DVT batch.' },
      { id:'george',  name:'George',    initials:'GV', role:'Founder / CEO',       type:'supporting',
        desc:'Funding and gate approvals. Signs off on stage transitions (DVT → PVT → PILOT → MP) and authorises production budget commitments.' },
    ],
    prd:{
      version:'PRD v2.1', updated:'Jun 2026',
      summary:'Residential automated composting system for Canadian households. Two-chamber thermophilic aerobic composting with AI moisture monitoring, WiFi-connected via LILA Lovely App.',
      problem:'Canadian households send ~100 kg of organic waste to landfill annually. No practical home solution handles full household food waste (300–500g/day) without odor, manual turning, or complicated setup.',
      targetMarket:'Canadian homeowners, ages 30–55, environmentally conscious. Households generating 300–500g/day of kitchen food waste. Premium appliance segment ($1,000+ price point).',
      goalLine:'Q4 2026: first EBITDA-positive quarter ($184,583 target, fin. model v13). 2027: 1,200 Pro units/year MP ramp. Q1 2027 MP gate contingent on 6 blocker resolution.',
      keySpecs:[
        'Two compost chambers — simultaneous composting and harvesting',
        'MCU: STM32N6 + ESP32-C6 (WiFi/BT)',
        'Camera: OV5640 for AI waste identification and monitoring',
        'Sensors: BME280 humidity/temp, magnetic induction lid switch (replacing mechanical microswitch)',
        'Power: 120V AC, PTC heaters, TÜV certified',
        'Connectivity: WiFi 802.11 b/g/n, MQTT protocol, OTA firmware updates',
        'App: LILA Lovely App (PWA) — iOS + Android',
        'Cycle: 7–14 day thermophilic composting',
      ],
      mpRequirements:'6 MP blockers: Side Latch redesign (critical), OTA firmware failure on update (critical), Packaging ISTA 3A redesign, Motor keyed shaft design, Composting control algorithm audit, Signed firmware binary (SOC 2 readiness).',
      docRef:'LILA_PRD_CN.html · BenLiang D0.11 BOM · P100X in-production at MicroArt Markham',
      icp:[
        {
          tier:'Primary', persona:'The Eco-Committed Homeowner',
          profile:'Canadian homeowner, 35–55, HHI $120k+. Has tried green bin composting but finds it slow, smelly, or unreliable. Buys premium kitchen appliances (KitchenAid, Vitamix) and treats the kitchen as an extension of personal values.',
          demographics:['Age 35–55 · skews female as primary decision-maker','HHI $120k+ · Toronto, Vancouver, Ottawa metro areas','Homeowner — single-family or townhouse · counter space available'],
          psychographics:['Climate-anxious but action-oriented — wants real impact, not just signalling','Premium appliance buyer — Vitamix, Breville, KitchenAid comfort zone','Tracks household carbon footprint; has or wants solar / EV'],
          triggers:['Weekly guilt over food waste filling the green bin','New home purchase — kitchen setup moment','Friend or neighbour already owns a LILA Pro'],
          barriers:['Price — requires strong $1,000+ justification to self and partner','Counter space concern in smaller kitchens','Skepticism: "does it actually make compost, or just dry the food?"'],
        },
        {
          tier:'Secondary', persona:'The Sustainability-Led Young Couple',
          profile:'Ages 28–42, dual income, urban or inner suburb. Strong environmental identity. Composting is household identity — not just habit.',
          demographics:['Age 28–42 · dual income household · HHI $90k–$140k','Urban core or inner suburb · condo or semi-detached','Limited outdoor composting option'],
          psychographics:['Sustainability as identity marker — buys organic, shops local, tracks waste','Researches purchases carefully — reads reviews, watches unboxings before buying','Values data transparency — appreciates app-level monitoring and cycle history'],
          triggers:['Baby or toddler in household — heightened environmental awareness','Peer pressure from sustainability-forward social circle','Municipal rebate or tax credit for composting appliances'],
          barriers:['Budget tighter — needs payment plan or promotional pricing','Smaller counter space in condo or semi-detached','Both partners need to be aligned before purchase'],
        },
      ],
    },
    journey:[
      { stage:'Discovery', sub:'Becomes aware of LILA Pro',
        touchpoints:['Social media — Instagram, Facebook sustainability groups','Word of mouth: friend or neighbour demo','YouTube review or unboxing video'],
        emotion:'Curious', jtbd:'I want a real composting solution that actually works inside my home.' },
      { stage:'Research', sub:'Evaluates options',
        touchpoints:['lilacomposter.com product page and FAQ','Reddit r/composting, r/ZeroWaste discussion threads','Comparison vs. Vitamix FoodCycler, Lomi, Reencle'],
        emotion:'Evaluating', jtbd:'I need to understand if this is worth $1,000+ and actually produces real compost — not just dried food.' },
      { stage:'Purchase', sub:'Buys through Shopify',
        touchpoints:['lilacomposter.com checkout · Shopify payment flow','Order confirmation + shipping tracking email'],
        emotion:'Committed', jtbd:'I made the decision — now I want fast delivery and a clear setup experience.' },
      { stage:'Onboarding', sub:'Unboxing, app setup, first cycle',
        touchpoints:['Unboxing + quick-start card','LILA Lovely App download + machine pairing via serial #','First cycle completion notification via app'],
        emotion:'Excited', jtbd:'I want this set up in under 20 minutes and to see it actively working the same day.' },
      { stage:'Active Use', sub:'Daily composting routine',
        touchpoints:['Daily waste input — lid open/close detected automatically','App monitoring: temp, humidity, cycle progress charts','OTA firmware updates delivered silently'],
        emotion:'Satisfied', jtbd:'I want it to run in the background and only notify me when something needs attention.' },
      { stage:'Retention', sub:'Post-purchase follow-up sequence',
        touchpoints:[
          'Day 7: Onboarding check-in email — "How is your first week with LILA?"',
          'Day 30: Sean Ellis PMF Survey (Klaviyo) — 5 questions · target ≥40% Very Disappointed',
          'Day 60: Consumables reminder (starter pellets, filter bags reorder) + Trustpilot review request',
          'Day 90: Branch on Day 30 Q1 response — ① Very Disappointed → Brand Ambassador invite · ③④ Not Disappointed → CS save call',
        ],
        emotion:'Evaluating', jtbd:'I want the team to check in at the right moments — not constantly, but enough to know my experience matters to them.' },
      { stage:'Advocacy', sub:'Shares and refers',
        touchpoints:['Instagram post showing compost output','Referral to friend or neighbour','Shopify product review (5 stars)'],
        emotion:'Proud', jtbd:'I want to show this off — it made a real difference and the compost is something I\'m proud of.' },
    ],
    pmf:{
      updated:'Jul 2026', status:'early',
      statusLabel:'Early Signals — Insufficient Data to Declare PMF',
      summary:'Organic demand is real: 2 units/week move without paid ads, and MSRP holds without discounting — two genuine pull signals. Unit economics are borderline at ~30% COGS/MSRP and CAC is severely elevated by paid media. Customer satisfaction is impaired by known hardware defects (all now critical-priority tickets). PMF cannot be declared until HW blockers resolve, return rate falls below 5%, and advocacy is tracked.',
      dimensions:[
        { id:'pull', label:'Pull Demand', question:'Are people seeking this out without being pushed?', metrics:[
          { label:'Organic Conversion', val:'2 units / wk', target:'> 10 / wk', status:'warn', note:'Confirmed baseline — no paid ads running. Genuine pull demand exists. Pre-scale, but real.' },
          { label:'Organic Share of Sales', val:'—', target:'> 40%', status:'na', note:'Not broken out in Shopify. Requires UTM attribution audit to separate paid vs. organic revenue.' },
          { label:'Word-of-Mouth / Referral Rate', val:'—', target:'> 10%', status:'na', note:'Brand ambassador program is active, but % of buyers who generate a referred sale is not tracked. Add to makeLILA customer record.' },
        ]},
        { id:'economics', label:'Unit Economics', question:'Can we deliver value profitably at scale?', metrics:[
          { label:'COGS / MSRP', val:'~30%', target:'< 30%', status:'warn', note:'BOM ~$300 CAD target vs. $999 CAD MSRP. On the threshold. BLDC motor-gearbox swap may reduce COGS 15–20%.' },
          { label:'Customer Acquisition Cost', val:'$400–600 CAD', target:'< $150 CAD', status:'crit', note:'Driven by paid media. Organic-only CAC is ~$0 at 2 units/wk baseline. Reducing paid dependency is required.' },
          { label:'LTV / CAC Ratio', val:'—', target:'> 3×', status:'na', note:'Requires LTV model across accessories, consumables (pellets, filters), service plans, and referral value. Not yet calculated.' },
        ]},
        { id:'satisfaction', label:'Customer Satisfaction', question:'Are customers getting what they expected after the purchase?', metrics:[
          { label:'Return & Refund Rate', val:'28% blended · 19% product', target:'< 5%', status:'crit', note:'49 entries in returns system ÷ 177 shipped = 27.7% blended rate. Reclassified Jul 8: 16 of 49 are long-wait order cancellations (unused condition, delivery-time problem, not product problem). True product return rate: 33 ÷ 177 = 18.6%. Emerging Q3 trend: "doesn\'t actually compost — just dehydrates" — 4+ returns Jul 2026 with this complaint.' },
          { label:'Trustpilot Score', val:'4.5 ★', target:'≥ 4.5 ★', status:'ok', note:'~18 reviews · Jul 2026 · lilacomposter.com on Trustpilot' },
          { label:'Support Ticket Rate', val:'~20%', target:'< 5%', status:'crit', note:'36 tickets across 177 shipped units (field report May 2026, 11 hardware categories). Tracks directly to open critical HW tickets — expected to fall as defects close.' },
        ]},
        { id:'advocacy', label:'Customer Advocacy', question:'Are customers recommending without being paid or prompted?', metrics:[
          { label:'Net Promoter Score', val:'—', target:'> 50', status:'na', note:'VCycene NPS = composite of Trustpilot score and brand ambassador conversion rate. Neither is formally measured yet.' },
          { label:'Brand Ambassador Conversion', val:'—', target:'> 5% of buyers', status:'na', note:'Program exists. % of buyers who enroll and actively generate a referral not tracked in makeLILA.' },
          { label:'Unprompted Social Sharing', val:'Qualitative only', target:'Qualitative baseline', status:'na', note:'Monitor @lilacomposter mentions, Trustpilot free-text, and Google Alerts. No formal tracking cadence.' },
        ]},
        { id:'retention', label:'Engagement Retention', question:'After the sale, do customers stay engaged? (durable-goods PMF proxy)', metrics:[
          { label:'Willingness to Pay at MSRP', val:'Confirmed', target:'No forced discounting', status:'ok', note:'$999 CAD MSRP has held across all DVT, PVT, and PP batches without promotional pricing. Strongest PMF signal available today.' },
          { label:'Consumables Repurchase Rate', val:'—', target:'> 30% within 90 days', status:'na', note:'Starter pellets, filter bags — proxy for active daily use. Not tracked in Shopify yet.' },
          { label:'Sean Ellis PMF Test', val:'—', target:'> 40% "Very Disappointed"', status:'na', note:'5-question survey · deploy via Klaviyo at Day 30 + Day 90 post-purchase. Q1: "How would you feel if you could no longer use LILA?" Scoring: ≥40% answering "Very disappointed" = PMF signal. See Retention stage in Customer Journey for deployment schedule.' },
        ]},
      ],
    },
  },
  mini: {
    name:'LILA Mini', badgeClass:'badge-crit', badgeCount:'7',
    currentStage:'EVT', currentStatus:'in-progress',
    currentLabel:'EVT — In Progress',
    customStages: STAGES,
    stageStates:{ EP:'done', EVT:'active', DVT:'future', PVT:'future', PILOT:'future', MP:'future' },
    kpis:[
      { label:'Current Stage',    val:'EVT',    sub:'Eng. Validation · Jul 2026',       cls:'' },
      { label:'Open Issues',      val:'7',      sub:'2 critical · 3 high',              cls:'v-crit' },
      { label:'Critical Blocker', val:'Motor',  sub:'Shaft mismatch — in rework',       cls:'v-crit' },
      { label:'DVT Gate',         val:'Q4 2026',sub:'est. · pending motor resolution',  cls:'' },
    ],
    issues:[
      { title:'Motor-Gearbox Shaft Mismatch', sev:'critical',
        tag:'EVT · DVT Blocker', team:'Chen Zong / Wang Gong',
        meta:'Round motor shaft (Electrical div.) vs. D-shaped gearbox coupling (Mechanical div.) — physical incompatibility. Parts returned for rework. Root cause: two divisions designed interdependent parts in isolation with no interface control document. New BLDC motor+gearbox assembly (300 RMB/2 complete sets, 1:980–1:1007 ratio) being validated. Blocks DVT gate.' },
      { title:'Dev Board Delayed to Canada', sev:'critical',
        tag:'EVT · PM', team:'Chen Zong / Wang Yang',
        meta:'Dev board (STM32N6 + peripherals) scheduled to ship week of Jun 23 — not shipped until ~Jun 30. 1-week delay caused Lezhong\'s firmware work in Canada to stall. Dev board received at BL facility Jul 5; components shipped to Meigongyuan Jul 6.' },
      { title:'Gearbox Processing Precision Failures', sev:'high',
        tag:'EVT · Supply Chain', team:'Wang Gong / Chen Zong',
        meta:'Gearbox parts failed dimensional QC — returned for rework multiple times. 2–3 week cumulative delay. Backup OEM supplier in Shenzhen Guangming (self-produces gearbox+motor, ~100k units/year) proposed. Chen + Kevin to visit.' },
      { title:'STM32 N6 Firmware Bring-up', sev:'high',
        tag:'EVT · Firmware', team:'Lezhong Lin / Li Gong',
        meta:'New chip (STM32N6, 178-pin BGA) — limited team N6 experience. Dual-track strategy: dev board for SW debug in Canada; custom Mini board for full bring-up in China. Dev board kit shipped to Meigongyuan Jul 6.' },
      { title:'Lid Microswitch Shipping Damage', sev:'high',
        tag:'EVT · Hardware', team:'Chen Zong',
        meta:'3 confirmed cases — rear lid presses microswitch continuously during shipping, causing breakage on arrival. Permanent fix: replace with magnetic induction switch — confirmed Jul 6 meeting, same change applied to LILA Pro.' },
      { title:'No Formal BOM', sev:'medium',
        tag:'EVT · Engineering', team:'Chen Zong',
        meta:'Only informal engineer\'s list exists — no version control, no traceability. Formal BOM with version numbers must be established from EPT stage. Confirmed as corrective action Jun 29 meeting.' },
      { title:'Prototype 3D Print + Color Spec', sev:'medium',
        tag:'EVT · Prototype', team:'Chen Zong / Wang Yang',
        meta:'3D printing of all mechanical parts and oil spraying target: complete this week (Jul 6). Prototype assembly target: next week (Jul 13). Color spec: black, silver, white, red — exact match to LILA Pro aesthetics. Needed for crowdfunding video production in Canada.' },
    ],
    notes:[
      { label:'EVT Status',    val:'Two complete board sets manufactured (Jun 16). Dev board received Jul 5; components shipped to Meigongyuan Jul 6. Motor+gearbox integration blocked by shaft mismatch — new BLDC assembly being validated on large machine.' },
      { label:'Critical Path', val:'Motor-gearbox resolution is the DVT gate blocker. Parallel execution mandated (Jun 29): 3D printing, SW debug on dev boards (Canada), BOM setup, supplier visits — all running simultaneously.' },
      { label:'Crowdfunding',  val:'LaunchBoom partnership active. Target: 2,000 pre-orders by end 2026. EVT unit required for crowdfunding video in Canada. Hundreds of thousands CAD in marketing spend contingent on hardware delivery timeline.' },
    ],
    timeline:[
      { id:'EP',    label:'Engineering Prototype',  status:'done',   date:'Feb – Mar 2026 · ARP proposal, early BL engagement' },
      { id:'EVT',   label:'Engineering Validation', status:'active', date:'Apr – Aug 2026 · PCB design, board bring-up, motor validation' },
      { id:'DVT',   label:'Design Validation',      status:'future', date:'Q4 2026 est. · pending motor resolution + prototype' },
      { id:'PVT',   label:'Pilot Validation',        status:'future', date:'Q1 2027 est.' },
      { id:'PILOT', label:'Pilot Production',        status:'future', date:'Q2 2027 est.' },
      { id:'MP',    label:'Mass Production',         status:'future', date:'2027 · 2,000 crowdfunding pre-orders target' },
    ],
    volumes:[
      { stage:'EP',    count:2,    type:'actual',  sub:'Concept prototypes · Feb 2026' },
      { stage:'EVT',   count:2,    type:'actual',  sub:'Debug system sets (dev board + Mini board) · Jul 2026' },
      { stage:'DVT',   count:15,   type:'planned', sub:'est. · pending DVT gate' },
      { stage:'PVT',   count:50,   type:'planned', sub:'est. Q1 2027' },
      { stage:'PILOT', count:150,  type:'planned', sub:'est. Q2 2027' },
      { stage:'MP',    count:null, type:'tbd',     sub:'2027 · 2,000 crowdfunding target' },
    ],
    bom:[
      { pn:'LMN-001', name:'Compact housing (ABS)', qty:1, unit:'pc', cost:'TBD' },
      { pn:'LMN-002', name:'Inner liner', qty:1, unit:'pc', cost:'TBD' },
      { pn:'LMN-003', name:'BLDC motor + worm gearbox (1:980–1007)', qty:1, unit:'set', cost:'150' },
      { pn:'LMN-004', name:'Control PCB (STM32N6 custom)', qty:1, unit:'pc', cost:'TBD' },
      { pn:'LMN-005', name:'STM32N6 dev board set', qty:1, unit:'set', cost:'300' },
      { pn:'LMN-006', name:'OV5640 camera module', qty:1, unit:'pc', cost:'TBD' },
      { pn:'LMN-007', name:'Carbon filter (compact)', qty:1, unit:'pc', cost:'TBD' },
    ] as BomItem[],
    team:[
      { id:'lezhong',  name:'Lezhong Lin',  initials:'LZ', role:'Firmware Engineer (Canada)', type:'primary', desc:'N6 chip firmware in Canada — motor control, camera, sensor processing, wireless. Leads SW debug on dev board kit shipped Jul 6.' },
      { id:'li-gong',  name:'Li Gong',      initials:'LG', role:'Firmware Engineer (China)',  type:'primary', desc:'Local custom PCB bring-up — STM32N6 init, motor driver, peripherals. STM32 experience, new to N6.' },
      { id:'zhu-gong', name:'Zhu Gong',     initials:'ZG', role:'Hardware Engineer',          type:'primary', desc:'PCB design for LILA Mini custom board. Coordinates with Li Gong on board bring-up.' },
      { id:'wang-gong',name:'Wang Gong',    initials:'WG', role:'Mechanical Engineer',        type:'primary', desc:'Gearbox and motor mechanical design. Working on resolution with new BLDC+gearbox assembly validation.' },
      { id:'chen-zong',name:'Chen Zong',    initials:'CZ', role:'BL Production Manager',      type:'primary', desc:'Production coordination, supplier management, component logistics for all Mini EVT work.' },
      { id:'wang-yang',name:'Wang Yang',    initials:'WY', role:'Project Assistant (BL)',      type:'supporting', desc:'Added Jun 29 as project coordinator. Email/WeChat comms, shipping logistics, meeting follow-up.' },
      { id:'huayi',    name:'Huayi Gao',    initials:'HG', role:'Product Manager',            type:'primary', desc:'Product strategy, project management, crowdfunding. Drives parallel execution mandate, manages LaunchBoom timeline.' },
    ],
    prd:{ version:'TechDoc Rev6', updated:'Jul 2026', summary:'Compact apartment-sized composting system. Crowdfunding launch target: 2,000 pre-orders via LaunchBoom partnership by end 2026. Currently in EVT — motor-gearbox integration in progress.', problem:'Apartment dwellers generate 100–200g/day of food waste with no composting option. Existing solutions are too large, too odorous, or require outdoor access.', targetMarket:'Urban apartment dwellers, ages 25–45, single households or couples. Sustainability-minded early adopters. LaunchBoom target price range CAD $200–400.', goalLine:'EVT → DVT gate Q4 2026 (pending motor resolution). Crowdfunding campaign 2026. Inventory build Q1 2027. 2,000 pre-orders target via LaunchBoom.', keySpecs:['MCU: STM32N6 (178-pin BGA) + ESP32-C6 WiFi/BT','Motor: BLDC + worm gearbox 1:980–1:1007 reduction, max 5 RPM, 300 RMB/2 complete sets','Camera: OV5640 for AI waste identification','Sensors: BME280 humidity/temp, IR sensor, magnetic induction lid switch','Power: 120V AC (North American), TÜV certification in progress','Form: Compact counter-top; Colors: Black/Silver/White/Red','Connectivity: WiFi 802.11 b/g/n, Bluetooth LE','Dev track: STM32N6 dev board kit for parallel SW debug while custom PCB bring-up continues'], mpRequirements:'DVT gate blockers: motor-gearbox shaft mismatch resolution, TÜV cert documentation, formal BOM v01+ establishment, 3D prototype assembly completion + crowdfunding video production.', docRef:'LILA_Mini_TechDoc_Rev6.html · VCycene_LILA_Mini_LaunchBoom.html · BL meetings Jun–Jul 2026' },
    journey:[
      { stage:'Discovery', sub:'Finds crowdfunding campaign', touchpoints:['LaunchBoom campaign page','Social media ad or organic share','Friend who backed LILA Pro'], emotion:'Curious', jtbd:'I want an apartment-friendly composter that doesn\'t smell or take up my entire counter.' },
      { stage:'Backer', sub:'Backs on Kickstarter', touchpoints:['Kickstarter campaign page','Early bird pledge tier','Campaign update emails'], emotion:'Hopeful', jtbd:'I\'m betting on this team to deliver something that actually fits apartment life.' },
      { stage:'Wait', sub:'Pre-order production period', touchpoints:['Campaign update emails','Manufacturing milestone posts','Backer support channel'], emotion:'Patient', jtbd:'Keep me informed — I want to know this is real and on track.' },
      { stage:'Delivery', sub:'Unit arrives', touchpoints:['Shipping notification','Unboxing experience','App download + machine pairing'], emotion:'Excited', jtbd:'I want to start composting the same day it arrives.' },
      { stage:'Active Use', sub:'Daily composting routine', touchpoints:['Daily waste input','App monitoring','Customer support if needed'], emotion:'Satisfied', jtbd:'I want it to fit apartment life without becoming another chore.' },
      { stage:'Advocacy', sub:'Refers and reviews', touchpoints:['Social share','App store review','Referral to neighbours'], emotion:'Proud', jtbd:'I want my neighbours to ask about it when they visit.' },
    ],
  },
  mega: {
    name:'LILA Mega', badgeClass:null, badgeCount:null,
    currentStage:'EP', currentStatus:'in-progress',
    currentLabel:'EP — In Progress',
    customStages: STAGES,
    stageStates:{ EP:'active', EVT:'future', DVT:'future', PVT:'future', PILOT:'future', MP:'future' },
    kpis:[
      { label:'Current Stage', val:'EP',      sub:'Eng. Prototype',         cls:'v-success' },
      { label:'Open Issues',   val:'1',       sub:'1 high',                 cls:'' },
      { label:'Next Gate',     val:'EVT',     sub:'Q1 2027 est.',           cls:'' },
      { label:'EP Batch',      val:'2',       sub:'prototypes planned',     cls:'' },
    ],
    issues:[],
    notes:[
      { label:'Concept',       val:'Commercial-scale unit for restaurants, cafeterias, and multi-family buildings. Engineering prototype phase starting Q3 2026.' },
      { label:'Key Challenges',val:'Larger motor and heating element sizing. Higher-capacity filter. Modular inoculant dispensing (from R&D).' },
      { label:'EP Target',     val:'2 units — internal validation. LILA Pro DVT learnings feeding into Mega motor and switch design.' },
    ],
    timeline:[
      { id:'EP',    label:'Engineering Prototype',  status:'active', date:'Q3 2026' },
      { id:'EVT',   label:'Engineering Validation', status:'future', date:'Q1 2027 est.' },
      { id:'DVT',   label:'Design Validation',      status:'future', date:'Q2 2027 est.' },
      { id:'PVT',   label:'Pilot Validation',        status:'future', date:'Q3 2027 est.' },
      { id:'PILOT', label:'Pilot Production',        status:'future', date:'Q4 2027 est.' },
      { id:'MP',    label:'Mass Production',         status:'future', date:'2028 est.' },
    ],
    volumes:[
      { stage:'EP',    count:2,    type:'planned' },
      { stage:'EVT',   count:5,    type:'planned' },
      { stage:'DVT',   count:10,   type:'planned' },
      { stage:'PVT',   count:30,   type:'planned' },
      { stage:'PILOT', count:100,  type:'planned' },
      { stage:'MP',    count:null, type:'tbd' },
    ],
    bom:[] as BomItem[],
    team:[
      { id:'huayi',  name:'Huayi Gao',   initials:'HG', role:'Product Manager',  type:'primary', desc:'Product manager for Mega. Defines commercial requirements, coordinates EP engineering, and manages the Hong Kong PC partnership.' },
      { id:'george', name:'George',       initials:'GV', role:'Founder / CEO',    type:'primary', desc:'Project approver. Authorises EP investment and go/no-go for each gate. Primary contact for Mary\'s investor relationship.' },
      { id:'hkpc',   name:'Hong Kong PC', initials:'HK', role:'Design Partner',   type:'supporting', desc:'Industrial design partner based in Hong Kong. Filing a joint grant application with VCycene for the Mega.' },
      { id:'mary',   name:'Mary',         initials:'MY', role:'Investor & Pilot', type:'supporting', desc:'Early investor providing funding for the Mega program. Also acting as a pilot partner — one of the first commercial sites to test the EP unit.' },
    ],
    prd:{ version:'PRD v1.1', updated:'Jul 2, 2026', summary:'Commercial vermicomposting system for institutional and municipal organic waste. 100 kg/day throughput with automated IoT monitoring, AI moisture model, contamination vision, and auditable GHG avoidance MRV reporting.', problem:'Institutions generating 50–200 kg/day of organic waste pay $80–200/tonne for hauling with no on-site alternative. Ontario landfills receive 2.8M tonnes of organics/year; methane at 27.9× CO₂ warming potential.', targetMarket:'B2G: municipal waste managers, city-operated facilities. B2B: food service operators, university canteens, hospitals. First pilots: Niagara College Q4 2026, HK/Shenzhen H1 2027.', goalLine:'v1.0: 100 kg/day validated at Niagara College pilot Q4 2026. ≥120 t CO₂e/unit/year avoided. OPEX < $80 CAD/tonne. 3 signed commercial LOIs by Q2 2028.', keySpecs:['Throughput: 100 kg/day sustained (30-day average, NC pilot target)','Process: 14–21 day multi-chamber — thermophilic → vermicomposting (Eisenia fetida)','Output: ANL A-class vermicompost ($800–2,000/tonne)','AI moisture model: RMSE ≤ 10.0 target (current baseline 13.51, trained 74,525 samples / 46 cycles)','Vision: mAP@0.5 ≥ 0.80 contamination detection (plastic, metal, glass, hazard)','Odor: NH₃ < 25 ppm, H₂S < 1 ppm at unit perimeter (99% uptime)','MRV: Auto monthly GHG report — ECCC Tier 1 methodology, PDF + CSV export, 3yr data retention'], mpRequirements:'EP stage: HKPC partnership co-development — live worm integration, temperature regulation automation, MRV reporting layer. NC pilot Q4 2026 → HK/Shenzhen pilot H1 2027 → 3 commercial LOIs Q2 2028.', docRef:'VCycene_LILA_Mega_PRD_v1.md · HKPC partnership · McMaster OCI C2C · ANL Lab A-class cert' },
    journey:[
      { stage:'Awareness', sub:'Institution learns of LILA Mega', touchpoints:['Sustainability conference or summit','Municipal program tender or RFP','VCycene direct outreach','University partner referral (Niagara College, McMaster)'], emotion:'Exploring', jtbd:'We need an on-site organics solution that genuinely meets our diversion targets and reporting requirements.' },
      { stage:'Qualification', sub:'Initial meeting + technical review', touchpoints:['VCycene sales call','Technical spec deep-dive','Site capacity assessment','Reference call with Niagara College pilot'], emotion:'Assessing', jtbd:'Can this handle our volume, meet our standards, and run without requiring a specialist on-site?' },
      { stage:'Pilot', sub:'Trial deployment', touchpoints:['LOI signing','Site preparation and installation','Staff training (2-hour onboarding)','30-day pilot operation + MRV report'], emotion:'Testing', jtbd:'Show me the real numbers — throughput, odor levels, cost per tonne, and the GHG report.' },
      { stage:'Validation', sub:'Pilot results review', touchpoints:['Auto-generated GHG avoidance report','ANL A-class compost certificate','Operator feedback collection','Stakeholder presentation to leadership'], emotion:'Evaluating', jtbd:'I need data I can defend to city council, the sustainability committee, or a board of governors.' },
      { stage:'Deployment', sub:'Full commercial installation', touchpoints:['Contract signing','Commissioning','Ongoing cloud monitoring dashboard','Annual MRV reporting'], emotion:'Committed', jtbd:'This needs to run reliably for years with minimal operator intervention.' },
      { stage:'Expansion', sub:'Multi-unit or peer referral', touchpoints:['Fleet management dashboard (v2.0)','Case study publication','Peer municipality or institution referral'], emotion:'Advocating', jtbd:'We want to expand and help peer institutions adopt the same solution.' },
    ],
  },
  makelila: {
    name:'makeLILA', badgeClass:'badge-high', badgeCount:'1',
    currentStage:'ALPHA', currentStatus:'in-progress',
    currentLabel:'Alpha — Active Development',
    customStages:[
      { id:'CONCEPT', label:'Concept' }, { id:'INFRA', label:'Infra' }, { id:'ALPHA', label:'Alpha' },
      { id:'BETA', label:'Beta' }, { id:'V1', label:'V1' }, { id:'LIVE', label:'Live' },
    ],
    stageStates:{ CONCEPT:'done', INFRA:'done', ALPHA:'active', BETA:'future', V1:'future', LIVE:'future' },
    kpis:[
      { label:'Version',   val:'Alpha', sub:'v0.1.0-infra shipped · lila.vip',  cls:'' },
      { label:'Modules',   val:'9',     sub:'OrderReview to ActivityLog',        cls:'' },
      { label:'Shippers',  val:'4',     sub:'Huayi · Pedrum · Junaid · Reina',  cls:'' },
      { label:'Stack',     val:'React', sub:'+ Supabase + GitHub Pages',         cls:'' },
    ],
    issues:[
      { title:'PMF Live Dashboard — Link Marketing & Sales Activity to Pro PMF Stats', sev:'high', tag:'Product · PMF', team:'Pedrum', meta:'All marketing and sales activity tracked in makeLILA should feed live into the LILA Pro PMF metrics — specifically Organic Conversion rate, Organic Share of Sales, Word-of-Mouth / Referral Rate, and CAC. Pedrum to audit which sales and marketing events are currently logged in makeLILA, define the data fields needed for each PMF dimension, and build the dashboard view that auto-updates the Pro PMF pill from live order/lead data.' },
    ],
    notes:[
      { label:'What It Is',     val:'Internal fulfillment management app for VCycene / LILA. Single source of truth for all operational data — orders, fulfillment, returns, stock, customers, and templates.' },
      { label:'Architecture',   val:'React 18 + TypeScript + Vite, Supabase (Postgres + Auth + Realtime), CSS Modules, GitHub Pages hosting at lila.vip. Auth via Supabase Google OAuth (VCycene org emails).' },
      { label:'Next Milestone', val:'P1 features: Google Maps address verification, Returns & Refunds overhaul, Email/SMS templates for common scenarios, Shopify payment summary sync.' },
    ],
    timeline:[
      { id:'CONCEPT', label:'Concept & architecture',    status:'done',   date:'Early 2026' },
      { id:'INFRA',   label:'v0.1.0-infra shipped',      status:'done',   date:'Jun 2026' },
      { id:'ALPHA',   label:'Alpha — 4 shippers active', status:'active', date:'Jun 2026 – present' },
      { id:'BETA',    label:'Beta — P1 features complete',status:'future', date:'Q4 2026 est.' },
      { id:'V1',      label:'V1 — full module coverage', status:'future', date:'Q1 2027 est.' },
      { id:'LIVE',    label:'Live — all workflows in prod',status:'future',date:'2027' },
    ],
    volumes:[], bom:[] as BomItem[],
    team:[
      { id:'huayi',  name:'Huayi Gao', initials:'HG', role:'Cross-cutting & Finance',  type:'primary', desc:'Primary engineer for cross-cutting infrastructure, Finance module, Mobile, and shipping integration. Owns the Supabase schema, auth, and all infra decisions.' },
      { id:'pedrum', name:'Pedrum',    initials:'PD', role:'Sales & Pre-Sale modules', type:'primary', desc:'Shipper for Sales and Pre-sale features. Owns the Order Review workflow, customer pipeline views, and pre-sale management tools within makeLILA.' },
      { id:'junaid', name:'Junaid',    initials:'JU', role:'CS & Stock modules',       type:'primary', desc:'Shipper for Customer Service and Stock features. Owns the fulfillment queue, serial tracking, stock management, and CS ticket workflows.' },
      { id:'reina',  name:'Reina',     initials:'RN', role:'Customer Service module',  type:'primary', desc:'Shipper for Customer Service features. Owns return application review, CS-facing workflows, and service ticket handling within makeLILA.' },
    ],
    prd:{ version:'PRD v2026-06-06', updated:'Jun 2026', summary:'Internal fulfillment management web app for VCycene / LILA operations. Tracks the full order lifecycle — from intake through post-shipment (returns, refunds, replacements) — across 9 modules.', problem:'VCycene operations spanned Shopify, HubSpot, Gmail, OpenPhone/Quo, and spreadsheets. No unified view of order lifecycle, fulfillment status, or customer history. Operators checked 5 systems per inquiry.', targetMarket:'Internal VCycene team: 4 active operators (Huayi, Pedrum, Junaid, Reina). Scalable to 10–20 operators as Pro + Mini volumes grow.', goalLine:'Alpha: all 9 modules live on lila.vip (shipped). Beta: Shopify 2-way sync + Freightcom labels. v1.0: makeLILA as single source of truth — all external systems are inputs only.', keySpecs:['Stack: React 18 + TypeScript, Supabase (Postgres + Auth + Realtime), Vite, GitHub Pages','Auth: Google OAuth (VCycene org emails) + external email allowlist table','Modules: OrderReview · Fulfillment · Build · PostShipment · Service · Stock · Customers · Templates · ActivityLog','Integrations: Shopify orders sync, Freightcom labels, Resend email, QuickBooks (read-only), OpenPhone/Quo','Data policy: insert-on-conflict for all external syncs; makeLILA data never overwritten by external systems'], mpRequirements:'P1 backlog: Google Maps address verification, Returns/Refunds overhaul (reason dropdown + Finance review workflow + George/Julie approval layer), Email/SMS templates, Shopify payment summary sync.', docRef:'makelila_PRD_review.html · docs/PRD-2026-06-06.md · AGENTS.md · docs/feature-backlog-alpha-feedback.md' },
    journey:[
      { stage:'Onboarding', sub:'New operator joins the team', touchpoints:['Google OAuth login (VCycene email)','First order review walkthrough','Fulfillment queue orientation with senior operator'], emotion:'Learning', jtbd:'I want to understand the system quickly and handle my first orders without making mistakes.' },
      { stage:'Daily Ops', sub:'Core order management', touchpoints:['Fulfillment queue — Assign → Test → Dock → Label → Email','Address card and freight card review','PostShipment tab for returns and replacements'], emotion:'Efficient', jtbd:'I want to process my full queue without switching to Shopify, Gmail, or a spreadsheet.' },
      { stage:'Issue Handling', sub:'Exception and edge case resolution', touchpoints:['Returns tab — reason + status tracking','Refund workflow — Finance review → George/Julie approval','Service ticket creation → Service module'], emotion:'Resolving', jtbd:'I want clear status on every exception so nothing falls through the cracks.' },
      { stage:'Reporting', sub:'Operations status update', touchpoints:['Activity log export','Build pipeline board','Stock levels overview','Finance summary → George/Julie'], emotion:'Confident', jtbd:'I want to give leadership an accurate status update in under 5 minutes.' },
      { stage:'Feature Request', sub:'Operator identifies a gap', touchpoints:['Huayi feedback channel (WeChat/email)','Feature backlog doc (docs/feature-backlog-alpha-feedback.md)','Alpha feedback loop → next sprint'], emotion:'Engaged', jtbd:'If something slows me down, I want a direct path to getting it fixed fast.' },
    ],
  },
  lovely: {
    name:'Lovely App', badgeClass:'badge-crit', badgeCount:'10',
    currentStage:'BETA', currentStatus:'in-progress',
    currentLabel:'Beta — In Progress',
    customStages:[
      { id:'CONCEPT', label:'Concept' }, { id:'DESIGN', label:'Design' }, { id:'MVP', label:'MVP' },
      { id:'BETA', label:'Beta' }, { id:'LAUNCH', label:'Launch' }, { id:'GROWTH', label:'Growth' },
    ],
    stageStates:{ CONCEPT:'done', DESIGN:'done', MVP:'done', BETA:'active', LAUNCH:'future', GROWTH:'future' },
    kpis:[
      { label:'Current Stage', val:'Beta',  sub:'Live at beta-lovely',        cls:'' },
      { label:'Open Issues',   val:'10',    sub:'2 critical security',         cls:'v-crit' },
      { label:'Platform',      val:'PWA',   sub:'Next.js 16 · iOS & Android', cls:'' },
      { label:'Integration',   val:'LILA',  sub:'Shared telemetry + serial #', cls:'' },
    ],
    issues:[
      { title:'SEC-01: Users UPDATE RLS policy allows self-verify & privilege escalation', sev:'critical', tag:'Software · Security', team:'Ryan', meta:'UPDATE RLS policy has no WITH CHECK or column restriction. Any authenticated user can set is_verified = true, rewrite serial_number, or self-grant OTA permission from the browser. (beta-lovely #49)' },
      { title:'SEC-02: Cross-device IDOR via client-writable serial_number', sev:'critical', tag:'Software · Security', team:'Ryan', meta:'Serial-scoped routes resolve device from a client-writable field with no ownership check. Attacker can access any customer\'s data. Serials are predictable (100,000 combinations). (beta-lovely #50)' },
      { title:'SEC-03: Onboarding PATCH writes unvalidated serialNumber from request body', sev:'high', tag:'Software · Security', team:'Ryan', meta:'PATCH /api/onboarding accepts serial_number from request body via service-role client, bypassing RLS entirely. No format validation or ownership check. (beta-lovely #51)' },
      { title:'SEC-04: AI rate limiter in-memory per-instance, no spend ceiling', sev:'high', tag:'Software · Security', team:'Junaid', meta:'Rate limiter resets on restart and is per-instance. No daily spend ceiling — a single authenticated user can drive uncapped Anthropic costs (15 req/min × 24h). (beta-lovely #52)' },
      { title:'SEC-06: XSS via javascript: hrefs in chat markdown renderer', sev:'medium', tag:'Software · Security', team:'Ryan', meta:'Hand-rolled markdown renderer passes any href to <a> with no scheme allowlist. A prompt-injected javascript: link executes script in the app origin on click. (beta-lovely #54)' },
      { title:'SEC-07: AI endpoint reachable by unverified accounts', sev:'medium', tag:'Software · Security', team:'Ryan', meta:'Chat route requires only serial resolution, not is_verified. Middleware doesn\'t cover /api/*, so unverified users can call the paid AI endpoint directly. (beta-lovely #55)' },
      { title:'SEC-08: Missing security headers (CSP, HSTS, X-Frame-Options)', sev:'medium', tag:'Software · Security', team:'Ryan', meta:'No CSP, HSTS, X-Frame-Options, or nosniff headers. Authenticated dashboard is open to clickjacking; missing CSP amplifies XSS blast radius. (beta-lovely #56)' },
      { title:'SEC-09: TypeScript build errors ignored in production', sev:'medium', tag:'Software · Quality', team:'Ryan', meta:'typescript.ignoreBuildErrors: true means type-unsafe code ships. A regression in auth or serial-resolution logic would still deploy. (beta-lovely #57)' },
      { title:'Verification should be automatic via UUID', sev:'low', tag:'Software · Feature', team:'Ryan', meta:'Users enter a 10-digit unique ID that auto-matches the serial number in the DB, replacing the current manual verification process. (beta-lovely #15)' },
      { title:'Add partitions to Supabase telemetry tables', sev:'low', tag:'Software · Infrastructure', team:'Junaid', meta:'Partition temperature sensors, BME sensors, current, and events tables to manage growth. Events table is highest priority. (beta-lovely #4)' },
    ],
    notes:[
      { label:'What It Is',     val:'Customer-facing PWA for LILA Pro owners. Tracks composting sessions, shows machine health, and surfaces tips powered by LILA telemetry data.' },
      { label:'Integration',    val:'Shares the LILA Supabase project for telemetry tables. The serial_number column is the join key between Lovely App sessions and makeLILA records.' },
      { label:'Next Milestone', val:'Full public launch. Beta currently live at virgohomeio/beta-lovely. Ryan and Reina iterating on app features; Junaid owns compliance and infra.' },
    ],
    timeline:[
      { id:'CONCEPT', label:'Concept & scoping',             status:'done',   date:'Mar 2026' },
      { id:'DESIGN',  label:'Design & architecture',         status:'done',   date:'Apr 2026' },
      { id:'MVP',     label:'MVP build',                     status:'done',   date:'May 2026' },
      { id:'BETA',    label:'Beta — virgohomeio/beta-lovely',status:'active', date:'Jun 2026 – present' },
      { id:'LAUNCH',  label:'Public launch',                 status:'future', date:'TBD' },
      { id:'GROWTH',  label:'Growth & feature expansion',    status:'future', date:'TBD' },
    ],
    volumes:[], bom:[] as BomItem[],
    team:[
      { id:'ryan',   name:'Ryan',      initials:'RY', role:'Developer',          type:'primary', desc:'Main developer of the Lovely App. Owns the Next.js 16 PWA codebase, Supabase integration for session telemetry, and end-to-end feature development.' },
      { id:'reina',  name:'Reina',     initials:'RN', role:'Product Engineer',   type:'primary', desc:'Product engineer helping Ryan with app features. Translates customer service insights into feature requirements.' },
      { id:'huayi',  name:'Huayi Gao', initials:'HG', role:'Product Management', type:'primary', desc:'Product management for Lovely App. Defines the roadmap, manages integration with the LILA telemetry stack.' },
      { id:'junaid', name:'Junaid',    initials:'JU', role:'Compliance & Infra', type:'supporting', desc:'Compliance and infrastructure. Ensures the app meets data handling standards, manages Supabase access controls.' },
    ],
    prd:{ version:'PRD v1.0', updated:'2026', summary:'Customer-facing mobile PWA for LILA Pro owners. Remote composting cycle monitoring, guided onboarding, and smart notifications over WiFi-connected machine.', problem:'LILA Pro customers have no visibility into composting status without physically checking the machine. No remote diagnostics, no guided onboarding experience, no push alerts for completed cycles or faults.', targetMarket:'LILA Pro customers: Canadian homeowners who purchased or plan to purchase the LILA Pro. Extends to LILA Mini customers post-Mini launch (2027).', goalLine:'Beta live at beta-lovely.virgohome.io. Launch: coincide with LILA Pro MP ramp Q1 2027. Growth: LILA Mini integration 2027 post-launch.', keySpecs:['Platform: PWA (Progressive Web App) — Next.js 16, iOS + Android via browser','Auth: Supabase; device pairing via serial_number (join key with makeLILA + Pro telemetry tables)','Features: Live cycle status, temp/humidity charts, cycle history, onboarding wizard, smart alerts','Connectivity: Cloud-to-device via MQTT/Supabase realtime; device side WiFi via ESP32-C6','Security: 2 critical open issues — firmware auth + session management (P0 before launch)'], mpRequirements:'P0 pre-launch: resolve 2 critical security issues (auth + session). P1: push notifications, multi-device pairing. P2: LILA Mini compatibility (2027).', docRef:'LILA_PRD_CN.html · virgohomeio/beta-lovely · docs/integration-lilalovely-2026-06-07.md' },
    journey:[
      { stage:'Discovery', sub:'LILA Pro customer learns about app', touchpoints:['In-box quick-start card + QR code','Post-purchase email from VCycene','Machine pairing prompt on first power-on'], emotion:'Curious', jtbd:'Does the app actually add value, or is it just another download I\'ll never open?' },
      { stage:'Pairing', sub:'Downloads and connects machine', touchpoints:['PWA install (iOS/Android via browser)','Serial number entry + WiFi credential setup','ESP32-C6 pairing handshake'], emotion:'Hopeful', jtbd:'I want this connected and working in under 3 minutes.' },
      { stage:'Monitoring', sub:'Checks composting progress', touchpoints:['Live cycle status on home screen','Temp and humidity charts over time','Push notification: cycle complete or action needed'], emotion:'Engaged', jtbd:'I want to see that it\'s actually doing something — real sensor data, not a spinner.' },
      { stage:'Guidance', sub:'Follows smart prompts', touchpoints:['Onboarding wizard (first 3 cycles)','AI tip: "add brown material to balance moisture"','Troubleshooting flow for error states'], emotion:'Informed', jtbd:'Tell me what the machine needs before I have to guess or search the manual.' },
      { stage:'Habit', sub:'Composting becomes daily routine', touchpoints:['Daily app check (sub-30 seconds)','Cycle history at a glance','Share cycle stats on social'], emotion:'Satisfied', jtbd:'Composting is part of my routine now — the app makes it feel like a game I\'m winning.' },
      { stage:'Advocacy', sub:'Refers and shares', touchpoints:['Instagram story showing compost output','App Store review','Referral to friend who just bought LILA Pro'], emotion:'Proud', jtbd:'I want to show people what real home composting looks like in 2026.' },
    ],
  },
  shop: {
    name:'LILA Shop', badgeClass:'badge-crit', badgeCount:'6',
    currentStage:'GROW', currentStatus:'in-progress',
    currentLabel:'Live — DTC Channel',
    customStages:[
      { id:'LAUNCH', label:'Launch' }, { id:'GROW', label:'Growth' },
      { id:'SCALE', label:'Scale' }, { id:'MKTP', label:'Marketplace' },
    ],
    stageStates:{ LAUNCH:'done', GROW:'active', SCALE:'future', MKTP:'future' },
    kpis:[
      { label:'Sales Rate',   val:'~16/wk',   sub:'target 100 units/month · H2 2026',         cls:'' },
      { label:'SEO Health',   val:'42/100',   sub:'target 70 · up from 35 in Apr 2026',       cls:'v-med' },
      { label:'True CAC',     val:'$400–600', sub:'target $50–60 (5–6% of unit cost)',         cls:'v-crit' },
      { label:'Return Rate',  val:'10%',      sub:'$3–4M annual loss projected at scale',      cls:'v-crit' },
    ],
    issues:[
      { title:'CAC $400–600 vs. $50–60 Target — Marketing Spend Unsustainable', sev:'critical', tag:'Marketing · Conversion', team:'George / Pedrum', meta:'True customer acquisition cost $400–600 against a 5–6% target of $999 unit price ($50–60). $555K marketing budget allocated for 2026. 36 of 47 early sales were US despite Canada-first positioning. Path: SEO to 70+, content flywheel from 70 published blog posts, shift spend mix to organic channels.' },
      { title:'10% Return Rate — $3–4M Annual Loss Projected', sev:'critical', tag:'Post-Sale · Finance', team:'George / Huayi', meta:'10% return rate at $999 ASP, including shipping, restocking, and Sezzle fee non-recoverability, projects to $3–4M annual loss at scale. Higher refund rate among Sezzle financing buyers vs. direct-pay. Contributing factors: expectation mismatch, P100 shipment 70 days late, firmware blockers on delivery.' },
      { title:'50% of Sales via Sezzle — Cash Flow Gap + Higher Churn Risk', sev:'high', tag:'Finance · Cash Flow', team:'George', meta:'Sezzle financing accounts for ~50% of orders. 30-day payout delay creates a cash flow gap. Financed buyers show higher return rates vs. direct-pay. Strategy needed: Sezzle qualification criteria review, direct-pay incentive (discount or accessory bundle).' },
      { title:'Site Performance — 430KB Pages, 54 External Scripts, Sync Lottie.js', sev:'high', tag:'Technical · SEO', team:'Pedrum / Huayi', meta:'Product page HTML: 430KB. Homepage: 319KB. 47–54 external scripts per page; only ~10 async/deferred. Primary LCP blocker: Lottie.js (251KB) loaded synchronously in <head>. Target: <20 external scripts, all async, Lottie deferred or replaced with CSS animation.' },
      { title:'SEO Health 42/100 — Empty H1, HTTP OG Image, Liquid Errors', sev:'medium', tag:'SEO · Technical', team:'Pedrum / Raquel', meta:'SEO health score 42/100 (up from 35 in April 2026; target 70). Empty H1 on homepage, OG image served over HTTP not HTTPS. 3 Liquid template errors, 48 inline gstatic font references. 70 blog posts live — solid content base but not yet converting to rankings.' },
      { title:'Gross Margin 24–27% — BOM ~$600 vs. $340 Target', sev:'medium', tag:'Finance · COGS', team:'George / Huayi', meta:'Current gross margin 24–27% at $999 CAD ASP; BOM ~$600. Target margin requires BOM reduction to ~$340, dependent on LILA Mini/Pro motor+gearbox cost breakthrough and MP volume ramp.' },
    ],
    notes:[
      { label:'Site Status',     val:'lilacomposter.com — live Shopify DTC store. Single active SKU: LILA Pro ($999 CAD). 70 blog posts published. SEO health 42/100 and improving month-over-month.' },
      { label:'Marketing Stack', val:'$555K 2026 marketing budget. Google + Meta paid media. Raquel (marketing intern May 4 – Aug 28, 2026) managing content calendar. Pedrum owns Shopify dev + paid campaigns. Sezzle financing for ~50% of orders.' },
      { label:'Next Initiative', val:'LILA Marketplace Phase 1 — Q3 2026. Curated sustainable products via Shopify Collective drop-ship at lilacomposter.com/pages/marketplace. 26 Canadian vendor candidates, 7 sustainability categories.' },
    ],
    timeline:[
      { id:'LAUNCH', label:'Site Launch',        status:'done',   date:'2024–2025 · Shopify theme, LILA Pro listing, blog foundation' },
      { id:'GROW',   label:'DTC Growth',         status:'active', date:'2025–2026 · ~16 units/week · $555K marketing · SEO 42→70 roadmap' },
      { id:'SCALE',  label:'Scale + Optimise',   status:'future', date:'Q3–Q4 2026 · CAC reduction · site perf fixes · return rate below 5%' },
      { id:'MKTP',   label:'Marketplace Phase 1',status:'future', date:'Q3 2026 · 26 CA vendors · Shopify Collective · $2K+/mo GMV target' },
    ],
    volumes:[
      { stage:'H1 2026',  count:null, type:'actual',  sub:'~16 units/week avg · exact total in Shopify' },
      { stage:'H2 2026',  count:100,  type:'planned', sub:'units/month target · 1,200/year run rate' },
      { stage:'2027',     count:1200, type:'planned', sub:'aligned with LILA Pro MP ramp' },
      { stage:'2028+',    count:3700, type:'planned', sub:'fundraising model target (SEO + brand flywheel)' },
    ],
    bom:[
      { pn:'OPS-001', name:'Shopify subscription', qty:1, unit:'mo', cost:'$299' },
      { pn:'OPS-002', name:'Sezzle financing fee', qty:1, unit:'%/txn', cost:'3–4%' },
      { pn:'OPS-003', name:'Paid media (Google + Meta)', qty:1, unit:'mo', cost:'~$46K' },
      { pn:'OPS-004', name:'LILA Pro unit COGS (BOM)', qty:1, unit:'unit', cost:'~$600' },
      { pn:'OPS-005', name:'NA shipping + packaging', qty:1, unit:'unit', cost:'TBD' },
    ] as BomItem[],
    team:[
      { id:'george',  name:'George',     initials:'GR', role:'CEO · Strategy', type:'primary', desc:'Product pricing, marketing budget, return rate policy, Sezzle strategy. Final approver on all financial and channel decisions.' },
      { id:'pedrum',  name:'Pedrum',     initials:'PD', role:'Shopify Dev · Marketing', type:'primary', desc:'Shopify theme development, site performance optimization, paid media campaigns (Google/Meta). Owns CAC reduction and SEO implementation.' },
      { id:'raquel',  name:'Raquel',     initials:'RQ', role:'Marketing Intern', type:'supporting', desc:'Content creation, blog publishing, social media management. May 4 – Aug 28, 2026 contract term.' },
      { id:'ryan',    name:'Ryan Yuan',  initials:'RY', role:'Development Intern', type:'supporting', desc:'Development intern supporting Shopify theme work. Also the primary developer of the LILA Lovely App.' },
      { id:'huayi',   name:'Huayi Gao', initials:'HG', role:'CTO · Shopify Admin', type:'primary', desc:'Shopify admin, technical integrations, Marketplace Phase 1 implementation, Shopify Collective vendor onboarding.' },
    ],
    prd:{ version:'Backlog v1 (Jun 2026)', updated:'Jun 2026', summary:'DTC e-commerce storefront at lilacomposter.com — the primary sales channel for LILA Pro at $999 CAD via Shopify. Current focus: CAC reduction from $400–600 to $50–60, SEO improvement from 42→70, site performance fixes, and LILA Marketplace Phase 1 launch (Q3 2026).', problem:'DTC sales at $999 CAD with a $400–600 CAC burns cash. 50% of orders on Sezzle financing with 30-day payout delay and higher return rates. Site performance and SEO underperforming (42/100 score), limiting organic discovery.', targetMarket:'Canadian and US eco-conscious homeowners. Primary: Ontario and BC homeowners. Secondary: US buyers (historically 36 of first 47 units sold). LILA Marketplace: Canadian Shopify brands (26 Tier-1 vendors) seeking curated sustainable placement.', goalLine:'H2 2026: 100 units/month. SEO health score 70+. CAC to $50–60. Return rate <5%. LILA Marketplace Phase 1 live Q3 2026 with $2,000+/month gross sales from curated sustainable partners.', keySpecs:['Platform: Shopify custom theme — lilacomposter.com','Active SKU: LILA Pro $999 CAD; LILA Marketplace curated products launching Q3 2026','Financing: Sezzle (~50% take rate, 3–4% fee, 30-day payout)','SEO: 42/100 health (target 70) — fix empty H1, OG HTTPS, Liquid errors, defer scripts','Performance target: <20 external scripts (currently 47–54), remove sync Lottie.js (251KB)','Marketing: $555K budget 2026 — Google + Meta paid; content flywheel from blog'], mpRequirements:'Q3 2026: LILA Marketplace live at /pages/marketplace (10+ products, 5+ brands, $2K+/mo). Performance: <20 external scripts, async Lottie, HTTPS OG image. SEO: visible keyword H1, score 70+.', docRef:'backlog.md · lilacomposter-audit-log.md · lilacomposter-ux-audit.html' },
    journey:[
      { stage:'Discovery', sub:'Finds lilacomposter.com', touchpoints:['Google search (organic or paid ad)','Instagram/Facebook ad','LILA blog post or YouTube review','Word of mouth from existing owner'], emotion:'Curious', jtbd:'I\'ve been looking for a real home composting solution — I want to understand if this actually works.' },
      { stage:'Research', sub:'Evaluates LILA Pro', touchpoints:['Product page (430KB — slow load)','70 blog posts on composting tips','YouTube reviews + comparisons','Lomi, FoodCycler, Reencle competitor comparison'], emotion:'Evaluating', jtbd:'Is $999 worth it? Does it produce actual compost, or just dehydrate the food like the others?' },
      { stage:'Purchase', sub:'Decides to buy', touchpoints:['Add to cart on Shopify','Sezzle financing offer shown (50% take rate)','Credit card direct checkout'], emotion:'Committed', jtbd:'I\'ve decided. I want checkout to be simple and I need to know when this will arrive.' },
      { stage:'Delivery', sub:'Awaits and receives shipment', touchpoints:['Order confirmation email','Shipping tracking (BenLiang → NA)','Packaging condition on arrival','Unboxing + quick-start card quality'], emotion:'Hopeful', jtbd:'I hope the packaging is intact — I\'m paying $999 and expect it to feel premium when it arrives.' },
      { stage:'Post-Purchase', sub:'Uses the product or requests return', touchpoints:['LILA Lovely App pairing','Customer support (ServiceRequest → makeLILA)','Return request if expectation mismatch'], emotion:'Evaluating', jtbd:'Is this living up to what the site promised? Do I keep it, or is the 10% I\'ve heard about going to apply to me?' },
      { stage:'Retention', sub:'Brand becomes part of lifestyle', touchpoints:['LILA email newsletter','LILA Marketplace discovery','Social media community follow','Referral to friend or neighbour'], emotion:'Loyal', jtbd:'The composter works. I trust this brand — I\'m open to other sustainable products they curate.' },
    ],
  },
  marketplace: {
    name:'LILA Marketplace', badgeClass:null, badgeCount:null,
    currentStage:'BUILD', currentStatus:'in-progress',
    currentLabel:'Build — In Progress',
    customStages:[
      { id:'PLAN', label:'Planning' }, { id:'DESIGN', label:'Design' }, { id:'BUILD', label:'Build' },
      { id:'PHASE1', label:'Phase 1' }, { id:'PHASE2', label:'Phase 2' }, { id:'PHASE3', label:'Phase 3' },
    ],
    stageStates:{ PLAN:'done', DESIGN:'done', BUILD:'active', PHASE1:'future', PHASE2:'future', PHASE3:'future' },
    kpis:[
      { label:'Current Stage', val:'Build',  sub:'Phase 1 development',      cls:'' },
      { label:'T1 Vendors',    val:'26',     sub:'Canadian Shopify brands',  cls:'' },
      { label:'Next Milestone',val:'Launch', sub:'Phase 1 soft launch',      cls:'' },
      { label:'Categories',    val:'7',      sub:'Kitchen, Care, Pet & more',cls:'' },
    ],
    issues:[
      { title:'Vendor Shopify Collective onboarding', sev:'medium', tag:'Phase 1', team:'Business Dev', meta:'10 priority vendors need Collective invitations sent and accepted before Phase 1 soft launch. Earth Rated, Nellie\'s Clean, Abeego are top priority.' },
      { title:'Certification protocol — legal sign-off pending', sev:'medium', tag:'Legal', team:'Operations', meta:'Vendor agreement template and certification protocol V1 need legal review before any vendor contracts are executed.' },
    ],
    notes:[
      { label:'Platform',       val:'Shopify Collective (drop-ship) — vendors fulfill directly. LILA earns 20–40% commission per sale. Zero inventory held by VCycene.' },
      { label:'Phase 1 Target', val:'10 Canadian Shopify brands live at soft launch. Priority outreach: Earth Rated, Nellie\'s Clean, Abeego, Etee, The Future is Bamboo.' },
      { label:'Certification',  val:'LILA Certification Badge requires physical test in a LILA composter. ≤10% residue through 2 mm sieve within stated compost time (max 90 days).' },
    ],
    timeline:[
      { id:'PLAN',   label:'Planning & PRD',                    status:'done',   date:'Jun 2026' },
      { id:'DESIGN', label:'Design & Certification Protocol',   status:'done',   date:'Jun 2026' },
      { id:'BUILD',  label:'Build — Shopify + Collective setup',status:'active', date:'Jul – Sep 2026' },
      { id:'PHASE1', label:'Phase 1 — 10 Canadian Shopify brands live', status:'future', date:'Q4 2026' },
      { id:'PHASE2', label:'Phase 2 — US brands + affiliate links', status:'future', date:'Q1 2027' },
      { id:'PHASE3', label:'Phase 3 — Self-serve vendor portal',     status:'future', date:'2027' },
    ],
    volumes:[
      { stage:'T1 ID',     label:'Tier 1 Identified', count:26, type:'actual' },
      { stage:'OUTREACH',  label:'In Outreach',        count:12, type:'actual' },
      { stage:'SIGNED',    label:'Agreements Signed',  count:3,  type:'actual' },
      { stage:'LIVE',      label:'Live at Launch',     count:0,  type:'planned' },
      { stage:'T2 ID',     label:'Tier 2 Identified',  count:49, type:'planned' },
      { stage:'T2 TARGET', label:'Tier 2 Phase 2 Target', count:10, type:'planned' },
    ],
    bom:[] as BomItem[],
    team:[
      { id:'huayi',  name:'Huayi Gao', initials:'HG', role:'Product Manager',  type:'primary', desc:'Main product manager for the Marketplace. Owns the Shopify Collective integration, runs physical certification tests, and drives the Phase 1 vendor onboarding roadmap.' },
      { id:'pedrum', name:'Pedrum',    initials:'PD', role:'Sales & Pre-Sale', type:'supporting', desc:'Vendor outreach and partnership support. Assists with Tier 1 brand introductions and Shopify Collective invitations alongside Huayi.' },
      { id:'george', name:'George',    initials:'GV', role:'Founder / CEO',    type:'supporting', desc:'Approver for vendor agreements, commission structures, and any legal matters. Signs off before any brand partnership contract is executed.' },
    ],
    prd:{ version:'PRD v1.0', updated:'2026', summary:'Curated Canadian sustainable products marketplace. Commission-based model built on LILA brand trust. Phase 1: 26 Tier-1 Canadian Shopify vendors across 7 sustainability categories.', problem:'LILA customers are environmentally conscious early adopters who make purchasing decisions based on sustainability values. No curated North American marketplace vets products for genuine sustainability credentials with a trusted brand behind it.', targetMarket:'LILA Pro/Mini owners and eco-conscious Canadian households. B2B: Canadian Shopify brands (Tier 1) seeking curated sustainable placement and premium audience access.', goalLine:'Phase 1: soft launch with 26 T1 vendors. Phase 2: reviews + loyalty points + expanded categories. Phase 3: private label + sustainability scoring system.', keySpecs:['Business model: curated commission-based marketplace — not open listing, manually vetted','Vendor tier: 26 Tier-1 Canadian Shopify brands across 7 categories','Categories: Kitchen · Personal Care · Pet · Home Essentials · Garden · Baby · Wellness','Trust layer: LILA verification badge — sustainability criteria + brand alignment check','Tech: Shopify storefront integration, branded LILA marketplace presence'], mpRequirements:'Phase 1: vendor onboarding flow, product catalog, checkout integration. Phase 2: customer reviews + LILA loyalty points. Phase 3: private label products + algorithmic sustainability scoring.', docRef:'LILA_Marketplace_PRD.html · lilacomposter.com' },
    journey:[
      { stage:'Discovery', sub:'Eco-shopper finds the marketplace', touchpoints:['LILA email to Pro/Mini customer base','Homepage banner on lilacomposter.com','Social media sustainable shopping post'], emotion:'Curious', jtbd:'I trust LILA — if they curate it, it clears the sustainability bar I actually care about.' },
      { stage:'Browsing', sub:'Explores product categories', touchpoints:['Category filter (Kitchen, Care, Pet…)','LILA verification badge on listings','Product detail page + brand story'], emotion:'Exploring', jtbd:'I want to find products I\'d never find on Amazon — things that are genuinely sustainable.' },
      { stage:'Purchase', sub:'Buys from a Tier-1 vendor', touchpoints:['Add to cart → Shopify checkout flow','Order confirmation email','Shipping directly from vendor'], emotion:'Committed', jtbd:'I want a smooth checkout and confidence that my money is going to a real, vetted brand.' },
      { stage:'Post-Purchase', sub:'Product arrives and is used', touchpoints:['Delivery experience','Product performance vs. expectations','Review request email','LILA loyalty points credited'], emotion:'Evaluating', jtbd:'Did this live up to the LILA curation standard? My next purchase depends on the answer.' },
      { stage:'Return Visit', sub:'Comes back to browse again', touchpoints:['New arrivals email','Seasonal sustainability campaign','Loyalty points notification'], emotion:'Loyal', jtbd:'The LILA Marketplace is where I shop for sustainable products now.' },
    ],
  },
};

export interface RDProject { title: string; status: 'active'|'research'|'proposed'; desc: string; lead: string; leadName: string; tag: string; }
export const RD_PROJECTS: RDProject[] = [
  { title:'Compose AI', status:'active', desc:'Machine-learning model for real-time composting parameter optimization — temperature, moisture, aeration. Feeds live recommendations to control PCB firmware.', lead:'HG', leadName:'Huayi Gao', tag:'AI / Firmware' },
  { title:'Vision AI — Waste Classification', status:'research', desc:'Computer vision pipeline to classify food waste type at the point of deposit. Informs composting program selection and estimated cycle time for all LILA models.', lead:'HG', leadName:'Huayi Gao', tag:'AI / Hardware' },
  { title:'Microbial Research — Prof. Euler', status:'active', desc:'Collaboration with Prof. Christian Euler on microbial inoculant formulation. Proprietary starter culture optimized for LILA\'s thermal and moisture profile.', lead:'CE', leadName:'Prof. Christian Euler', tag:'Microbiology' },
  { title:'Modular Inoculant Dispensing', status:'proposed', desc:'Hardware subsystem for LILA Mega that automates inoculant dosing based on Compose AI recommendations. Scope depends on microbial research outcomes.', lead:'HG', leadName:'Huayi Gao', tag:'Hardware / R&D' },
];

export function isProBom(bom: Product['bom']): bom is ProBom {
  return !Array.isArray(bom) && typeof bom === 'object' && 'groups' in (bom as object);
}
