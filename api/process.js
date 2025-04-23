import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static'; // Ruta al binario de ffmpeg
import formidable from 'formidable'; // Para parsear multipart/form-data
import fs from 'fs'; // File system
import path from 'path'; // Para manejo de rutas de archivo
import os from 'os'; // Para obtener el directorio temporal del sistema

// Configuración específica de Vercel: deshabilitar bodyParser predeterminado
export const config = {
  api: {
    bodyParser: false,
  },
};

// Handler principal de la función serverless
export default async function handler(req, res) {
  // 1. Verificar método HTTP (solo aceptar POST)
  if (req.method !== 'POST') {
    console.log(`Método no permitido: ${req.method}`);
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Definir rutas temporales ANTES del try/catch para poder limpiar en 'finally'
  let tempAudioPath = null;
  let tempOutputPath = null;

  try {
    // 2. Parsear el formulario multipart/form-data
    const { fields, files } = await parseForm(req);

    // Verificar que se recibió el archivo de audio
    if (!files.audio || !files.audio[0]) {
      console.log('No se encontró archivo de audio en la solicitud.');
      return res.status(400).json({ error: 'No se proporcionó archivo de audio (campo "audio").' });
    }

    const audioFile = files.audio[0];
    tempAudioPath = audioFile.filepath; // Ruta temporal donde formidable guardó el audio
    console.log(`Archivo de audio recibido y guardado temporalmente en: ${tempAudioPath}`);

    // 3. Definir rutas para video base y salida
    // Asegúrate de que 'video_base.webm' esté en la raíz de tu proyecto Vercel
    // o ajusta la ruta según sea necesario (ej. 'public/video_base.webm')
    const videoBasePath = path.join(process.cwd(), 'video_base.webm');
    tempOutputPath = path.join(os.tmpdir(), `output-${Date.now()}.webm`); // Salida en dir temporal

    // Verificar si el video base existe
    if (!fs.existsSync(videoBasePath)) {
      console.error(`Error Crítico: El archivo de video base no se encontró en ${videoBasePath}`);
      // No exponer la ruta completa al cliente por seguridad
      return res.status(500).json({ error: 'Error interno del servidor: Falta el archivo de video base.' });
    }
    console.log(`Usando video base: ${videoBasePath}`);
    console.log(`Archivo de salida temporal: ${tempOutputPath}`);

    // 4. Ejecutar FFmpeg
    console.log('Iniciando proceso con FFmpeg...');
    await runFFmpeg(videoBasePath, tempAudioPath, tempOutputPath);
    console.log('FFmpeg completado exitosamente.');

    // 5. Leer el archivo resultante y enviarlo como respuesta
    const outputFileBuffer = fs.readFileSync(tempOutputPath);
    console.log(`Archivo de salida leído (tamaño: ${outputFileBuffer.length} bytes).`);

    // Configurar cabeceras para la descarga del cliente
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Content-Disposition', `attachment; filename="video_final_${Date.now()}.webm"`);
    res.setHeader('Content-Length', outputFileBuffer.length); // Buena práctica incluir tamaño

    console.log('Enviando respuesta al cliente...');
    return res.status(200).send(outputFileBuffer);

  } catch (error) {
    // 6. Manejo centralizado de errores
    console.error('--- Error en el handler de la API ---');
    console.error(error); // Loguear el error completo en el servidor
    // Enviar un mensaje de error genérico o específico (cuidado con exponer detalles internos)
    return res.status(500).json({
        error: 'Ocurrió un error durante el procesamiento del video.',
        details: error.message || 'Detalle no disponible' // Opcional: enviar mensaje de error si se considera seguro
    });

  } finally {
    // 7. Limpieza de archivos temporales (¡MUY IMPORTANTE!)
    console.log('Realizando limpieza de archivos temporales...');
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
      try {
        fs.unlinkSync(tempAudioPath);
        console.log(`Archivo temporal de audio eliminado: ${tempAudioPath}`);
      } catch (unlinkErr) {
        console.error(`Error al eliminar archivo temporal de audio ${tempAudioPath}:`, unlinkErr);
      }
    }
    if (tempOutputPath && fs.existsSync(tempOutputPath)) {
      try {
        fs.unlinkSync(tempOutputPath);
        console.log(`Archivo temporal de salida eliminado: ${tempOutputPath}`);
      } catch (unlinkErr) {
        console.error(`Error al eliminar archivo temporal de salida ${tempOutputPath}:`, unlinkErr);
      }
    }
    console.log('Limpieza finalizada.');
  }
}

// --- Funciones Auxiliares ---

/**
 * Parsea la solicitud entrante usando formidable.
 * Retorna una promesa que resuelve con { fields, files }.
 */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    // Usar directorio temporal del sistema operativo para subidas
    const tempDir = os.tmpdir();
    const form = formidable({
        uploadDir: tempDir,
        keepExtensions: true, // Conservar extensión original (ej. .mp3)
        // maxFileSize: 10 * 1024 * 1024, // Opcional: Limitar tamaño de archivo (ej. 10MB)
    });

    form.parse(req, (err, fields, files) => {
      if (err) {
        console.error('Error al parsear el formulario con formidable:', err);
        // Mejorar mensaje de error para tipos comunes
        if (err.code === 'LIMIT_FILE_SIZE') {
           return reject(new Error('El archivo de audio excede el tamaño máximo permitido.'));
        }
        return reject(new Error('Error al procesar el archivo subido.'));
      }
      console.log('Formulario parseado. Fields:', fields, 'Files:', files);
      resolve({ fields, files });
    });
  });
}

/**
 * Ejecuta FFmpeg para combinar video y audio.
 * Retorna una promesa que resuelve al finalizar o rechaza si hay error.
 */
function runFFmpeg(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Indicar a fluent-ffmpeg dónde encontrar el ejecutable de ffmpeg
    // Esto es crucial porque ffmpeg-static lo descarga en node_modules
    const ffmpegExecutablePath = ffmpegStatic;
    if (!ffmpegExecutablePath) {
        return reject(new Error('No se pudo encontrar la ruta al ejecutable de ffmpeg-static.'));
    }
    ffmpeg.setFfmpegPath(ffmpegExecutablePath);
    console.log(`Usando ejecutable FFmpeg de: ${ffmpegExecutablePath}`);

    ffmpeg()
      .input(videoPath)       // Input 0: Video base
      .input(audioPath)       // Input 1: Audio del usuario
      .outputOptions([
        '-map 0:v:0',         // Mapear explícitamente el stream de video del input 0
        '-map 1:a:0',         // Mapear explícitamente el stream de audio del input 1
        '-c:v copy',          // Copiar codec de video (asume VP9 con alpha)
        '-c:a libvorbis',     // Codificar audio a Vorbis (compatible con WebM)
        // '-shortest',       // Opcional: Termina cuando el stream más corto finalice
        // '-q:a 4',          // Opcional: Calidad de audio Vorbis (0-10, mayor es mejor)
        // '-af apad',        // Opcional: Añadir silencio al final del audio si es más corto que el video
        // '-fflags +genpts' // Opcional: Puede ayudar con problemas de sincronización
      ])
      .output(outputPath)     // Archivo de salida
      .on('start', (commandLine) => {
        console.log('Comando FFmpeg generado: ' + commandLine);
      })
      .on('progress', (progress) => {
         // Loguear progreso puede ser útil pero muy verboso en Vercel logs
         // console.log('Procesando: ' + progress.percent + '% done');
      })
      .on('end', () => {
        console.log('Proceso FFmpeg finalizado con éxito.');
        resolve(); // Resuelve la promesa cuando FFmpeg termina
      })
      .on('error', (err, stdout, stderr) => {
        console.error('--- Error durante la ejecución de FFmpeg ---');
        console.error('Mensaje:', err.message);
        console.error('Stdout:', stdout); // Salida estándar de FFmpeg
        console.error('Stderr:', stderr); // Salida de error de FFmpeg (¡muy importante!)
        // Crear un error más informativo
        reject(new Error(`Error en FFmpeg: ${err.message}. Stderr: ${stderr}`));
      })
      .run(); // Ejecutar el comando
  });
}
