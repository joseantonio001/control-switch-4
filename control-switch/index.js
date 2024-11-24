const express = require('express');
const net = require('net');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/control', (req, res) => {
    const { ip, username, password, tipoComando, interfaceName } = req.body;
    const client = new net.Socket();
    let comandoEnviado = false;
    let responseData = '';
    let reintentoComando100GE = false;

    // Selección del comando basado en el tipoComando y la interfaz (si aplica)
    let comando;
    if (tipoComando === "interfaces") {
        comando = "display interface description";
    } else if (tipoComando === "diagnosis") {
        // Ajusta el comando de diagnóstico según el tipo de interfaz
        if (interfaceName.startsWith("XGE")) {
            let formattedInterfaceName = interfaceName.replace(/^XGE/, "XGigabitEthernet");
            comando = `display transceiver diagnosis interface ${formattedInterfaceName}`;
        } else if (interfaceName.startsWith("10GE")) {
            comando = `display interface ${interfaceName} transceiver brief`;
        } else if (interfaceName.startsWith("100GE")) {
            comando = `display interface ${interfaceName} transceiver brief`;
        }  else if (tipoComando === "toggle" && interfaceName) {
            const comandoInterface = `interface ${interfaceName}`;
            const comandoPrimario = `shutdown`;
            const comandoAlternativo = `undo shutdown`;
            console.log("Enviando comando: wey", comandoInterface);
            try {
                // Envía el comando para entrar a la interfaz
                client.write(comandoInterface + '\n');
                console.log("Enviando comando:", comandoInterface);
        
                // Envía el comando primario
                setTimeout(() => {
                    client.write(comandoPrimario + '\n');
                    console.log("Intentando ejecutar comando primario:", comandoPrimario);
                }, 1000);
        
                // Escucha la respuesta para verificar éxito o error
                client.once("data", (data) => {
                    const response = data.toString();
                    console.log("Respuesta recibida:", response);
                    
        
                    if (response.includes("Error") || response.includes("Invalid")) {
                        console.error("Error detectado al ejecutar comando primario. Intentando comando alternativo...");
        
                        // Espera para enviar el comando alternativo
                        setTimeout(() => {
                            client.write(comandoAlternativo + '\n');
                            console.log("Ejecutando comando alternativo:", comandoAlternativo);
                        }, 1000);
                    } else {
                        console.log("Comando primario ejecutado correctamente.");
                    }
                });
            } catch (error) {
                console.error("Error al intentar ejecutar los comandos:", error.message);
            }
        }
        
        else {
            return res.status(400).json({ mensaje: "Tipo de interfaz no válido para diagnóstico" });
        }
       
    } else {
        return res.status(400).json({ mensaje: "Tipo de comando no válido" });
    }
    client.connect(23, ip, () => {
        console.log(`Conexión Telnet establecida con ${ip}`);
        
        // Agrega un retraso antes de enviar el nombre de usuario
        setTimeout(() => {
            client.write(`${username}\n`);
        }, 1000); // Retraso de 1 segundo
    });

    client.on('data', (data) => {
        const dataStr = data.toString();
        responseData += dataStr.replace(/---- More ----|\x1b\[\d+D/g, '');

        console.log('Recibido del switch:', dataStr); // Log de la respuesta recibida

        // Enviar contraseña cuando se solicite
        if (responseData.includes('Password:')) {
            setTimeout(() => {
                client.write(`${password}\n`);
                console.log('Contraseña enviada');
                responseData = '';
            }, 500);
        }

        // Detecta el prompt inicial antes de enviar el comando
        if ((responseData.includes('<VELOCOMACAPONETA>') || responseData.includes('>')) && !comandoEnviado) {
            setTimeout(() => {
                // Intenta desactivar la paginación
                client.write('screen-length 0 temporary\n');
                console.log('Comando de longitud de pantalla enviado');

                setTimeout(() => {
                    client.write(`${comando}\n`);
                    console.log(`Comando ejecutado: ${comando}`);
                    comandoEnviado = true;
                    responseData = '';

                    // Enviar 10 espacios iniciales para avanzar la paginación rápidamente
                    for (let i = 0; i < 10; i++) {
                        setTimeout(() => client.write(' '), i * 500);
                    }
                }, 1500);
            }, 2000);
        }
        // Verifica si se recibió el error específico en 100GE y reintenta con el comando alternativo
        if (responseData.includes("Error:Too many parameters found at '^' position.")) {
            comando = `display transceiver diagnosis interface ${interfaceName}`;
            console.log('Error detectado en 100GE, reintentando con el comando alternativo:', comando);
            reintentoComando100GE = true;
            responseData = ''; // Reinicia el acumulador de respuesta
            client.write(`${comando}\n`);
            return; // Salimos de la función para evitar reintentos múltiples
        }

        // Detecta el prompt final indicando el final de la salida del comando
        if ((dataStr.includes('<VELOCOMACAPONETA>') || dataStr.includes('>')) && comandoEnviado) {
            // Formateo condicional de la salida basado en el tipo de comando
            let formattedResponse;
            if (tipoComando === "interfaces") {
                formattedResponse = formatInterfaceDescription(responseData);
            } else if (tipoComando === "diagnosis") {
                formattedResponse = responseData; // No formatear para diagnosis
            }

            console.log('Respuesta formateada:', formattedResponse); // Log de la respuesta formateada
            res.json({ mensaje: `Comando ejecutado en el switch ${ip}`, respuesta: formattedResponse });

            client.destroy();
        }
    });

    client.on('error', (err) => {
        console.error(`Error en la conexión Telnet con ${ip}:`, err);
        res.status(500).json({ mensaje: `Error en la conexión Telnet con ${ip}`, error: err.message });
    });
});

// Función para formatear la salida del comando "display interface description"
function formatInterfaceDescription(data) {
    const lines = data.split('\n');
    const tableStartIndex = lines.findIndex(line => line.includes('Interface') && line.includes('PHY') && line.includes('Protocol'));

    if (tableStartIndex === -1) return data; // Devuelve sin cambios si no encuentra la cabecera de la tabla

    // Solo selecciona las líneas a partir de la cabecera de la tabla
    const tableLines = lines.slice(tableStartIndex);

    // Filtra cualquier línea que solo contenga caracteres especiales o que no pertenezca a la tabla
    const cleanedTable = tableLines.filter(line => {
        return line.trim() && !line.includes('PHY:') && !line.startsWith('*') && !line.startsWith('#');
    });

    // Ajusta el formato agregando un salto de línea adicional en ciertos patrones
    const formattedTable = cleanedTable.map(line => {
        return line.replace(/([A-Za-z]+\d\/\d+\/\d+|XGE|Eth-Trunk|10GE|100GE)/g, '\n$&'); // Agrega un salto de línea antes de ciertas palabras
    });

    return formattedTable.join('\n'); // Une las líneas de la tabla limpia
}


app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
