# Revisão técnica — deteção de voz com baixo volume

## Problema confirmado
O detetor de pitch rejeitava qualquer frame com RMS abaixo de 0,015. Em gravações de telemóvel com ganho baixo, uma voz limpa pode ficar abaixo desse valor e o autotune não corrigia a afinação, mesmo quando a frequência fundamental estava dentro da faixa suportada.

## Alteração
O limiar absoluto foi reduzido para 0,003. O detetor continua a exigir correlação mínima de 0,52 e frequência aproximada entre 75 Hz e 460 Hz. Isto permite analisar takes mais baixos sem remover os critérios de periodicidade já existentes.

## Limitações
- Um limiar menor também pode permitir que ruído periódico seja analisado como pitch; a qualidade depende do microfone, ruído e sinal.
- Não foi implementada preservação independente de formantes.
- Não há teste auditivo nem teste num Redmi A3 nesta revisão.
