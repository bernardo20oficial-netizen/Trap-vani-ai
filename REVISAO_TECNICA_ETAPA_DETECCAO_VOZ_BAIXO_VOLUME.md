# Revisão técnica — deteção de voz com baixo volume

## Problema confirmado e alteração aplicada
O detetor de pitch rejeitava qualquer frame com RMS abaixo de 0,015. Em gravações de telemóvel com ganho baixo, uma voz limpa pode ficar abaixo desse valor e o autotune não corrigia a afinação, mesmo quando a frequência fundamental estava dentro da faixa suportada.

O limiar absoluto foi reduzido para 0,003. O detetor continua a exigir correlação mínima de 0,52 e frequência aproximada entre 75 Hz e 460 Hz.

## Problema adicional identificado, ainda não corrigido
Testes com tons sintéticos mostraram que o autocorrelador pode escolher um pico de período duplo: um sinal de 220 Hz foi por vezes estimado perto de 110 Hz. Não alterei a seleção dos picos nesta etapa porque uma correção incompleta poderia piorar outras vozes. Esta questão fica registada para uma revisão específica do algoritmo de deteção de pitch.

## Limitações e testes
- Um limiar menor também pode permitir que ruído periódico seja analisado como pitch; a qualidade depende do microfone, ruído e sinal.
- Não foi implementada preservação independente de formantes.
- Teste sintético confirmou que o novo limiar aceita um sinal de 220 Hz com RMS aproximado de 0,0042, que antes era rejeitado; o problema de oitava acima permanece.
- Não há teste auditivo nem teste num Redmi A3 nesta revisão.
