# Revisão técnica — Autotune e processamento vocal

## O que foi confirmado no código
- O processamento atual faz correção de afinação por análise de pitch e overlap-add com grãos.
- A duração e o número de canais da gravação são mantidos.
- A mistura dry/wet permite combinar a voz original com a processada.
- A preservação independente de formantes ainda não está implementada; a configuração `preserveFormants` é normalizada para `false` para não prometer uma função inexistente.
- O detector trabalha numa faixa aproximada de 75 Hz a 460 Hz e depende de confiança mínima; vozes fora da faixa ou com ruído podem não ser corrigidas de forma fiável.

## Alteração desta etapa
Foi acrescentada uma retenção curta da última razão de correção fiável durante até dois frames sem pitch detetado. Isto evita que pequenas falhas de deteção entre vogais e consoantes façam a correção saltar imediatamente para o pitch original. Depois dessa janela curta, a correção regressa gradualmente ao estado neutro.

Também foi removido um comentário interno que podia sugerir preservação avançada da identidade vocal. A interface já informa corretamente que a preservação avançada do timbre está em desenvolvimento.

## Limitações e testes
- Esta melhoria é uma mitigação de oscilações causadas por pequenas falhas de deteção; não transforma o motor num autotune profissional.
- O algoritmo de grãos ainda pode alterar formantes e produzir artefactos, especialmente com correções grandes, voz polifónica, ruído ou gravações muito curtas.
- Não foi possível validar a qualidade auditiva com uma gravação de referência neste ambiente.
- A compilação integral e os testes num Redmi A3/BandLab continuam pendentes.
