import React from 'react';

interface WeaponViewmodelSvgProps {
  weaponId: string;
  isFiring: boolean;
}

export const WeaponViewmodelSvg: React.FC<WeaponViewmodelSvgProps> = ({
  weaponId,
  isFiring,
}) => {
  const kickTransform = isFiring ? 'translate(8px, -3px) rotate(1.5deg)' : 'translate(0, 0)';

  const renderShape = () => {
    switch (weaponId) {
      case 'valkyrie_dmr':
        return (
          <g>
            {/* Long anti-materiel barrel + scope */}
            <path
              d="M28 62 L182 58 L194 61 L194 65 L178 66 L150 66 L142 74 L95 74 L84 89 L64 89 L70 74 L30 78 L18 82 L18 66 Z"
              fill="#161c28"
              stroke="#00f0ff"
              strokeWidth="1.4"
            />
            <rect x="182" y="57" width="16" height="6" fill="#ffb300" opacity="0.85" />
            {/* Optic rail & scope */}
            <path
              d="M68 58 L76 47 L128 47 L134 58 Z"
              fill="#0f141d"
              stroke="#ffb300"
              strokeWidth="1.2"
            />
            <line x1="72" y1="52" x2="130" y2="52" stroke="#00f0ff" strokeWidth="1" opacity="0.6" />
            {/* Mag */}
            <path d="M104 74 L122 74 L118 93 L102 93 Z" fill="#1b2332" stroke="#8c9bb5" strokeWidth="1" />
          </g>
        );
      case 'helios_plasma':
        return (
          <g>
            {/* Heavy plasma emitter frame */}
            <path
              d="M20 58 L158 55 L176 62 L176 74 L152 78 L98 78 L86 92 L62 92 L68 78 L24 84 Z"
              fill="#161c28"
              stroke="#00f0ff"
              strokeWidth="1.5"
            />
            {/* Plasma coil fins */}
            {[112, 124, 136, 148].map((x) => (
              <rect
                key={x}
                x={x}
                y="58"
                width="6"
                height="15"
                fill="#00f0ff"
                opacity={isFiring ? 0.95 : 0.45}
              />
            ))}
            {/* Drum cell */}
            <polygon
              points="96,78 134,78 138,96 92,96"
              fill="#0f141d"
              stroke="#ffb300"
              strokeWidth="1.2"
            />
          </g>
        );
      case 'kestrel_smg':
        return (
          <g>
            {/* Compact PDW */}
            <path
              d="M46 60 L146 58 L156 63 L156 71 L138 73 L96 73 L88 92 L70 92 L75 73 L46 76 Z"
              fill="#161c28"
              stroke="#ffb300"
              strokeWidth="1.4"
            />
            <path d="M112 73 L126 73 L120 96 L106 96 Z" fill="#0f141d" stroke="#00f0ff" strokeWidth="1.2" />
            <rect x="78" y="51" width="32" height="7" fill="#0f141d" stroke="#8c9bb5" strokeWidth="1" />
          </g>
        );
      case 'novacula_mg':
        return (
          <g>
            {/* Heavy squad machine gun */}
            <path
              d="M14 54 L184 51 L196 57 L196 71 L168 74 L112 76 L98 93 L68 93 L76 76 L16 84 Z"
              fill="#161c28"
              stroke="#ff2a4b"
              strokeWidth="1.5"
            />
            <rect x="172" y="53" width="22" height="14" fill="#1b2332" stroke="#ffb300" strokeWidth="1.2" />
            <line x1="56" y1="62" x2="165" y2="62" stroke="#ffb300" strokeWidth="1.5" strokeDasharray="8 4" />
            <rect x="108" y="76" width="34" height="18" fill="#0f141d" stroke="#8c9bb5" strokeWidth="1.2" />
          </g>
        );
      case 'choque_shotgun':
        return (
          <g>
            {/* Choque X24 combat shotgun with dual tube & wide choke */}
            <path
              d="M22 59 L176 57 L184 61 L184 67 L166 68 L166 74 L106 74 L86 90 L64 90 L72 74 L24 81 Z"
              fill="#161c28"
              stroke="#ffb300"
              strokeWidth="1.5"
            />
            <rect x="114" y="67" width="54" height="7" fill="#0f141d" stroke="#00f0ff" strokeWidth="1.2" />
            <rect x="176" y="56" width="12" height="10" fill="#ffb300" opacity="0.85" />
            <rect x="78" y="51" width="26" height="7" fill="#0f141d" stroke="#8c9bb5" strokeWidth="1" />
          </g>
        );
      case 'maelstrom_hammer':
        return (
          <g>
            {/* Maelstrom Siege Hammer */}
            <rect x="18" y="62" width="148" height="7" fill="#161c28" stroke="#8c9bb5" strokeWidth="1.2" />
            <polygon points="10,65 20,60 20,71" fill="#ffb300" />
            <rect x="40" y="60" width="32" height="11" fill="#0f141d" stroke="#00f0ff" strokeWidth="1.1" />
            <rect x="150" y="34" width="34" height="58" fill="#1b2332" stroke="#ffb300" strokeWidth="1.6" />
            <rect x="184" y="40" width="10" height="46" fill="#5c687c" stroke="#ffb300" strokeWidth="1.1" />
            <polygon points="150,54 132,65 150,74" fill="#5c687c" stroke="#ff2a4b" strokeWidth="1.1" />
            <line x1="156" y1="42" x2="178" y2="42" stroke="#ffb300" strokeWidth="2.2" />
          </g>
        );
      case 'valken_halberd':
        return (
          <g>
            {/* Valken Pole-Halberd */}
            <rect x="14" y="62" width="154" height="6" fill="#161c28" stroke="#8c9bb5" strokeWidth="1.2" />
            <polygon points="6,65 16,60 16,70" fill="#00f0ff" />
            <polygon points="168,58 214,65 168,72" fill="#5c687c" stroke="#00f0ff" strokeWidth="1.4" />
            <path
              d="M148 68 Q156 98 182 94 Q174 76 166 68 Z"
              fill="#1b2332"
              stroke="#00f0ff"
              strokeWidth="1.4"
            />
            <polygon points="148,62 138,46 158,62" fill="#5c687c" stroke="#ffb300" strokeWidth="1.2" />
          </g>
        );
      case 'm47_rail':
      default:
        return (
          <g>
            {/* M-47 Rail Carbine split twin rails */}
            <path
              d="M28 60 L170 57 L178 62 L178 67 L154 71 L100 71 L90 91 L68 91 L74 71 L30 78 L20 80 L20 65 Z"
              fill="#161c28"
              stroke="#00f0ff"
              strokeWidth="1.4"
            />
            <line x1="112" y1="62" x2="174" y2="62" stroke="#ffb300" strokeWidth="1.4" />
            {/* Holo sight */}
            <polygon
              points="74,59 80,48 110,48 116,59"
              fill="#0f141d"
              stroke="#ffb300"
              strokeWidth="1.2"
            />
            {/* Angled mag */}
            <polygon
              points="112,71 129,71 123,93 106,93"
              fill="#0f141d"
              stroke="#8c9bb5"
              strokeWidth="1.1"
            />
          </g>
        );
    }
  };

  return (
    <svg
      viewBox="0 0 230 110"
      className="w-44 sm:w-52 h-22 overflow-visible transition-transform duration-75"
      style={{ transform: kickTransform }}
      aria-hidden="true"
    >
      {/* Muzzle Flash on fire */}
      {isFiring && (
        <g transform="translate(196, 61)">
          <polygon
            points="0,0 24,-10 14,-2 32,0 14,2 24,10"
            fill="#ffb300"
            opacity="0.92"
          />
          <circle cx="4" cy="0" r="6" fill="#00f0ff" opacity="0.7" />
        </g>
      )}
      {renderShape()}
    </svg>
  );
};
