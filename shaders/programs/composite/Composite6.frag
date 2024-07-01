#extension GL_ARB_gpu_shader5 : enable

layout(location = 0) out vec4 texBuffer3;

in vec2 texcoord;
in vec3 skyColorUp;
in mat4 shadowModelViewProjection;

#include "/settings/CloudSettings.glsl"
#include "/settings/GlobalSettings.glsl"
#include "/settings/VolumetricLightSettings.glsl"
#include "/libs/Uniform.glsl"
#include "/libs/Common.glsl"
#include "/libs/Atmosphere.glsl"
#include "/libs/Cloud.glsl"
#include "/libs/GbufferData.glsl"
#include "/libs/Shadow.glsl"

float volumetricFogDensity(vec3 position) {
    position += cameraPosition;
    float heightClamp = pow2(2.0 / VOLUMETRIC_FOG_THICKNESS * position.y - 2.0 * VOLUMETRIC_FOG_CENTER_HEIGHT / VOLUMETRIC_FOG_THICKNESS);
    float result = 0.0;
    if (heightClamp < 1.0) {
        vec3 wind = vec3(2.0, 0.0, 1.0) * frameTimeCounter / VOLUMETRIC_FOG_SCALE * 0.001;
        vec3 fogPosition = position / VOLUMETRIC_FOG_SCALE * 0.001 + wind;

        float weight = 1.0;
        float density = 0.0;
        for (int i = 0; i < VOLUMETRIC_FOG_OCTAVES; i++) {
            density += smooth3DNoise(fogPosition) * weight;
            fogPosition = fogPosition * VOLUMETRIC_FOG_OCTAVE_SCALE + wind;
            weight *= VOLUMETRIC_FOG_OCTAVE_FADE;
        }
        const float weights = (1.0 - pow(VOLUMETRIC_FOG_OCTAVE_FADE, VOLUMETRIC_FOG_OCTAVES)) / (1.0 - VOLUMETRIC_FOG_OCTAVE_FADE);
        density = clamp(pow2(density / weights) + VOLUMETRIC_FOG_AMOUNT - 1.0 - VOLUMETRIC_FOG_AMOUNT * heightClamp, 0.0, 1.0);
        result = density;
    }
    return result;
}

void main() {
    float waterDepth = textureLod(depthtex0, texcoord, 0.0).r;
    vec3 waterViewPos = screenToViewPos(texcoord, waterDepth);
    float waterViewDepth = length(waterViewPos);
    vec3 waterWorldPos = viewToWorldPos(waterViewPos);
    vec3 waterWorldDir = normalize(waterWorldPos - gbufferModelViewInverse[3].xyz);

    ivec2 texel = ivec2(gl_FragCoord.st);
    float weatherData = texelFetch(colortex0, texel, 0).w;
    vec3 solidColor = texelFetch(colortex3, texel, 0).rgb;
    float waterViewDepthFar = waterViewDepth + step(0.999999, waterDepth) * 114514.0;
    if (isEyeInWater == 0) {
        #ifdef NETHER
            solidColor *= vec3(netherFogAbsorption(waterViewDepthFar));
            solidColor += netherFogScattering(waterViewDepthFar);
        #elif defined THE_END
            solidColor *= vec3(endFogAbsorption(waterViewDepthFar));
            solidColor += endFogScattering(waterViewDepthFar);
            if (waterDepth > 0.999999) {
                solidColor += endStars(waterWorldDir);
            }
        #else
            solidColor *= vec3(airAbsorption(waterViewDepthFar));
            #ifdef SHADOW_AND_SKY
                #ifdef ATMOSPHERE_SCATTERING_FOG
                    solidColor = solidAtmosphereScattering(solidColor, waterWorldDir, skyColorUp, waterViewDepth, eyeBrightnessSmooth.y / 240.0);
                #endif
            #endif
        #endif
    }
    else if (isEyeInWater == 1) {
        solidColor *= waterFogAbsorption(waterViewDepth);
        solidColor += waterFogScattering(waterWorldDir, skyColorUp, waterViewDepth, eyeBrightnessSmooth.y / 240.0);
    }
    else if (isEyeInWater == 2) {
        solidColor *= vec3(lavaFogAbsorption(waterViewDepth));
        solidColor += lavaFogScattering(waterViewDepth);
    }
    else if (isEyeInWater == 3) {
        solidColor *= vec3(snowFogAbsorption(waterViewDepth));
        solidColor += snowFogScattering(skyColorUp, waterViewDepth, eyeBrightnessSmooth.y / 240.0);
    }

    #ifdef VOLUMETRIC_LIGHT
        if (isEyeInWater < 2) {
            float waterWorldDistance = dot(waterViewPos, waterViewPos);

            float noise = bayer64Temporal(gl_FragCoord.xy);
            float maxAllowedDistance = pow2(far + 32.0) / (1.0 - min(waterWorldDir.y * waterWorldDir.y, 0.5)) * exp(-8.0 * blindnessFactor);

            vec3 origin = gbufferModelViewInverse[3].xyz;
            vec3 originShadowCoordNoBias = worldPosToShadowCoordNoBias(origin);
            vec3 target = (waterWorldPos - origin) * sqrt(min(waterWorldDistance, maxAllowedDistance) / (waterWorldDistance + 1e-5));
            vec3 targetShadowCoordNoBias = worldPosToShadowCoordNoBias(target + origin);
            vec3 stepSize = target / (VL_SAMPLES + 1.0);
            vec3 shadowCoordStepSize = (targetShadowCoordNoBias - originShadowCoordNoBias) / (VL_SAMPLES + 1.0);
            vec3 samplePos = origin + stepSize * noise;
            vec3 sampleShadowCoordNoBias = originShadowCoordNoBias + shadowCoordStepSize * noise;
            float stepLength = length(stepSize);

            float basicWeight = stepLength;
            vec3 absorptionBeta = vec3(blindnessFactor);
            float LdotV = dot(waterWorldDir, shadowDirection);
            float volumetricFogScattering = 0.0;
            float airScattering = VL_STRENGTH;
            if (isEyeInWater == 1) {
                absorptionBeta += waterAbsorptionBeta;
                basicWeight *= 10.0 * WATER_VL_STRENGTH;
                airScattering *= rayleighPhase(LdotV);
            }
            else {
                float timeStrength = pow(clamp(1.0 - shadowDirection.y, 0.0, 1.0), 5.0);
                float timeVLStrength = (timeStrength * (MORNING_VL_STRENGTH - NOON_VL_STRENGTH) + NOON_VL_STRENGTH) * exp(-max(cameraPosition.y, 0.0) / 1200.0);
                basicWeight *= timeVLStrength;
                airScattering *= miePhase(LdotV, 0.6, 0.36);

                volumetricFogScattering = VOLUMETRIC_FOG_DENSITY * (timeStrength * (VOLUMETRIC_FOG_MORNING_DENSITY - VOLUMETRIC_FOG_NOON_DENSITY) + VOLUMETRIC_FOG_NOON_DENSITY);
            }
            absorptionBeta *= stepLength * 1.44269502;
            vec3 rayAbsorption = exp2(-absorptionBeta * noise);
            vec3 stepAbsorption = exp2(-absorptionBeta);
            vec3 skyScattering = (sunColor * 2.0 + skyColorUp) * eyeBrightnessSmooth.y / 1000.0;
            stepLength *= -0.02 * 1.44269502;

            float absorption = 1.0;
            vec3 volumetricLight = vec3(0.0);
            for (int i = 0; i < VL_SAMPLES; i++) {
                vec3 singleLight = vec3(1.0);
                #ifdef CLOUD_SHADOW
                    singleLight *= cloudShadow(samplePos, shadowDirection);
                #endif
                vec3 sampleShadowCoord = biaShadowCoord(sampleShadowCoordNoBias);
                if (all(lessThan(
                    abs(sampleShadowCoord - vec3(vec2(0.75), 0.5)),
                    vec3(vec2(0.25), 0.5))
                )) {
                    float solidShadowStrength = textureLod(shadowtex0, sampleShadowCoord, 2.0);
                    singleLight *= vec3(solidShadowStrength);
                    sampleShadowCoord.y -= 0.5;
                    vec3 caustic = waterCaustic(sampleShadowCoord, samplePos, shadowDirection, 2.0);
                    singleLight *= caustic;
                    #ifdef TRANSPARENT_SHADOW
                        sampleShadowCoord.xy += vec2(-0.5, 0.5);
                        float transparentShadowStrength = textureLod(shadowtex0, sampleShadowCoord, 2.0);
                        if (transparentShadowStrength < 1.0) {
                            vec4 transparentShadowColor = textureLod(shadowcolor0, sampleShadowCoord.st, 2.0);
                            transparentShadowColor.rgb = pow(
                                transparentShadowColor.rgb * (1.0 - 0.5 * pow2(transparentShadowColor.w)),
                                vec3(sqrt(transparentShadowColor.w * 2.2 * 2.2 * 1.5))
                            );
                            singleLight *= mix(transparentShadowColor.rgb, vec3(1.0), vec3(transparentShadowStrength));
                        }
                    #endif
                }
                singleLight *= sunColor;
                #ifdef VOLUMETRIC_FOG
                    float sampleVolumetricFogDensity = volumetricFogDensity(samplePos) * volumetricFogScattering;
                    singleLight *= sampleVolumetricFogDensity * 5.0 + airScattering;
                    singleLight += sampleVolumetricFogDensity * skyScattering;
                #else
                    singleLight *= airScattering;
                #endif
                singleLight *= rayAbsorption;
                #ifdef VOLUMETRIC_FOG
                    float volumetricFogAbsorption = exp2(stepLength * sampleVolumetricFogDensity);
                    rayAbsorption *= volumetricFogAbsorption;
                    absorption *= volumetricFogAbsorption;
                #endif
                rayAbsorption *= stepAbsorption;
                volumetricLight += singleLight;
                samplePos += stepSize;
                sampleShadowCoordNoBias += shadowCoordStepSize;
            }
            volumetricLight *= (0.02 - 0.02 * sqrt(weatherStrength)) * basicWeight;
            solidColor = solidColor * absorption + volumetricLight;
        }
    #endif

    #ifdef SHADOW_AND_SKY
        weatherData = weatherData * 2.5 - 1.5;
        float weatherLightData = abs(weatherData);
        if (weatherLightData > 0.3) {
            float sunlightStrength = 2.0 * weatherLightData - 1.0;
            float basicSunlight = (1.0 - sqrt(weatherStrength)) * 8.0 * SUNLIGHT_BRIGHTNESS;
            vec3 weatherLight = sunlightStrength * basicSunlight * sunColor + skyColorUp * 1.5;
            float weatherBlendWeight = clamp(weatherData * 1e+10, 0.0, 1.0) * 0.8 + 0.2;
            solidColor = mix(solidColor, weatherLight, weatherBlendWeight);
        }
    #endif

    texBuffer3 = vec4(solidColor, 1.0);
}

/* DRAWBUFFERS:3 */
